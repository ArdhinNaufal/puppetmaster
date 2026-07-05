# Deploying Puppetmaster to Azure Kubernetes Service (AKS)

This guide provisions an AKS cluster sized for Puppetmaster's actual workload
(a small-team, self-hosted Fastify server + Postgres/pgvector + Redis/BullMQ,
per `docker/docker-compose.yml`) and deploys the manifests in `k8s/`.

Sizing assumptions (see prior sizing discussion): 2 app replicas, ~0.25-1 vCPU /
0.5-2 GiB per server pod, single region, low network throughput, no GPU,
burstable/spot nodes acceptable for the app tier.

This guide is written CLI-first. If you'd rather click through
**portal.azure.com**, jump to [Portal walkthrough](#portal-walkthrough)
below — it covers the same 9 steps using the Portal UI plus the built-in
Cloud Shell (there's no GUI for applying multi-resource YAML with secrets/HPA,
so that part still uses a shell — just one running inside the Portal, no
local install required).

## Prerequisites

- Azure CLI (`az`) logged in: `az login`
- `kubectl`
- Docker (to build the server image)
- An Azure subscription with quota for a couple of B-series VMs

Set some variables you'll reuse:

```bash
RG=puppetmaster-rg
LOCATION=eastus          # pick the region closest to your team
ACR_NAME=puppetmasteracr # must be globally unique, lowercase alphanumeric
AKS_NAME=puppetmaster-aks
```

## 1. Create a resource group

```bash
az group create --name $RG --location $LOCATION
```

## 2. Create an Azure Container Registry (ACR)

```bash
az acr create --resource-group $RG --name $ACR_NAME --sku Basic
```

## 3. Create the AKS cluster

Start with a small system node pool, then add a burstable user node pool for
the app workloads. `Standard_B2s` (2 vCPU / 4 GiB) comfortably fits 2-4 server
pods at the sizing above, plus Postgres/Redis.

```bash
az aks create \
  --resource-group $RG \
  --name $AKS_NAME \
  --location $LOCATION \
  --node-count 2 \
  --node-vm-size Standard_B2s \
  --nodepool-name systempool \
  --generate-ssh-keys \
  --attach-acr $ACR_NAME \
  --enable-cluster-autoscaler \
  --min-count 1 \
  --max-count 3
```

This gives you a single region, single node pool to start (matches the "1-2
node pools, single region" HA tier from the sizing answer). If you later need
multi-zone HA, add `--zones 1 2 3` at cluster creation time (zones can't be
added retroactively to an existing node pool).

Optional: add a dedicated, cheaper **spot** node pool for the stateless
`server` deployment, keeping the system pool for Postgres/Redis (which
shouldn't be evicted):

```bash
az aks nodepool add \
  --resource-group $RG \
  --cluster-name $AKS_NAME \
  --name apppool \
  --node-vm-size Standard_B2s \
  --priority Spot \
  --eviction-policy Delete \
  --spot-max-price -1 \
  --node-count 2 \
  --min-count 1 \
  --max-count 4 \
  --enable-cluster-autoscaler \
  --labels workload=app \
  --node-taints kubernetes.azure.com/scalesetpriority=spot:NoSchedule
```

If you add the spot pool, add this to `k8s/server.yaml` under `spec.template.spec`
so the server tolerates the taint and prefers that pool:

```yaml
      tolerations:
        - key: kubernetes.azure.com/scalesetpriority
          operator: Equal
          value: spot
          effect: NoSchedule
      nodeSelector:
        workload: app
```

## 4. Get cluster credentials

```bash
az aks get-credentials --resource-group $RG --name $AKS_NAME
kubectl get nodes
```

## 5. Build and push the server image to ACR

Run from the repo root:

```bash
az acr login --name $ACR_NAME
ACR_LOGIN_SERVER=$(az acr show --name $ACR_NAME --query loginServer -o tsv)

docker build -f docker/server.Dockerfile -t $ACR_LOGIN_SERVER/puppetmaster-server:latest .
docker push $ACR_LOGIN_SERVER/puppetmaster-server:latest
```

Update `k8s/server.yaml`'s `image:` field with the real value:

```bash
sed -i "s|<ACR_LOGIN_SERVER>/puppetmaster-server:<TAG>|$ACR_LOGIN_SERVER/puppetmaster-server:latest|" k8s/server.yaml
```

## 6. Create the namespace and secrets

```bash
kubectl apply -f k8s/namespace.yaml

kubectl create secret generic puppetmaster-secrets -n puppetmaster \
  --from-literal=POSTGRES_PASSWORD='<choose-a-strong-password>' \
  --from-literal=DATABASE_URL='postgres://puppetmaster:<same-password>@postgres:5432/puppetmaster' \
  --from-literal=REDIS_URL='redis://redis:6379'
```

(`k8s/secrets.example.yaml` documents the same fields if you prefer applying a
YAML file — copy it to `secrets.yaml`, fill in real values, and never commit
that file.)

## 7. Deploy Postgres, Redis, and the server

```bash
kubectl apply -f k8s/postgres.yaml
kubectl apply -f k8s/redis.yaml

# wait for both to be ready before starting the server
kubectl wait --for=condition=ready pod -l app=postgres -n puppetmaster --timeout=120s
kubectl wait --for=condition=ready pod -l app=redis -n puppetmaster --timeout=60s

kubectl apply -f k8s/server.yaml
kubectl get pods -n puppetmaster -w
```

`k8s/server.yaml` includes an HPA (2-4 replicas, scales on 70% CPU) matching
the sizing answer's "2 replicas baseline" with room to burst.

## 8. Expose the service (ingress)

Install the NGINX ingress controller (once per cluster):

```bash
helm repo add ingress-nginx https://kubernetes.github.io/ingress-nginx
helm repo update
helm install ingress-nginx ingress-nginx/ingress-nginx \
  --namespace ingress-nginx --create-namespace
```

Optional TLS via cert-manager + Let's Encrypt:

```bash
helm repo add jetstack https://charts.jetstack.io
helm repo update
helm install cert-manager jetstack/cert-manager \
  --namespace cert-manager --create-namespace --set installCRDs=true
```

Then create a `ClusterIssuer` for Let's Encrypt (standard cert-manager
boilerplate, not included here since it needs your email/ACME details), edit
`k8s/ingress.yaml`'s `host:` to your real domain, and apply:

```bash
kubectl apply -f k8s/ingress.yaml
kubectl get ingress -n puppetmaster
```

Point your domain's DNS A record at the ingress controller's external IP:

```bash
kubectl get svc ingress-nginx-controller -n ingress-nginx
```

If you don't have a domain yet, skip the ingress and just port-forward for
testing:

```bash
kubectl port-forward svc/server 4000:80 -n puppetmaster
```

## 9. Verify

```bash
kubectl get all -n puppetmaster
kubectl logs -l app=server -n puppetmaster --tail=50
curl http://localhost:4000/   # if port-forwarded, or your domain if ingress is set up
```

## Portal walkthrough

Everything below is the same 9 steps, done by clicking through
**portal.azure.com**. Steps 1-3 (resource group, ACR, AKS cluster) are pure
GUI. Steps 4-9 use **Azure Cloud Shell** — click the `>_` icon in the top nav
bar of the Portal. It's a free, browser-based shell with `az`, `kubectl`, `git`,
and `helm` pre-installed, so you never need to install anything locally. (It
does *not* have a Docker daemon, so image builds use `az acr build` instead of
`docker build` — see step 5.)

### 1. Create a resource group

Portal search bar → **"Resource groups"** → **+ Create** → fill in
Subscription, Resource group name (`puppetmaster-rg`), Region → **Review + create** → **Create**.

### 2. Create an Azure Container Registry (ACR)

Portal search bar → **"Container registries"** → **+ Create** → pick the
resource group from step 1, Registry name (globally unique, e.g.
`puppetmasteracr`), Location, SKU **Basic** → **Review + create** → **Create**.

### 3. Create the AKS cluster

Portal search bar → **"Kubernetes services"** → **+ Create** → **Create a Kubernetes cluster**:

- **Basics tab**: Resource group from step 1; Cluster name `puppetmaster-aks`;
  Region; Availability zones (leave default/None for single-region HA, or pick
  1,2,3 if you want multi-zone); under "Primary node pool" set node size to
  `Standard_B2s` and node count to 2.
- **Node pools tab**: the system pool from Basics is listed. Click **+ Add
  node pool** to add a second pool for the app tier (`apppool`), size
  `Standard_B2s`, enable autoscaling (min 1, max 4). If you want spot pricing
  for cost savings, set **Scale method** → **Spot** here (available as a
  dropdown when adding the pool).
- **Networking tab**: defaults are fine for this workload (Azure CNI or
  Kubenet both work; no special network policy needed at this scale).
- **Integrations tab**: under **Container registry**, select the ACR you
  created in step 2 — this does the equivalent of `--attach-acr` for you, so
  the cluster can pull images without extra credentials.
- **Review + create** → **Create**. Provisioning takes ~5-10 minutes.

### 4. Connect to the cluster

Open the new AKS resource → **Overview** → click **Connect**. It shows the
exact `az aks get-credentials` command for your cluster. Click the `>_` Cloud
Shell icon (top nav bar), paste that command in, then run:

```bash
kubectl get nodes
```

### 5. Get the repo and build/push the image (no local Docker needed)

In the same Cloud Shell:

```bash
git clone https://github.com/ArdhinNaufal/puppetmaster.git
cd puppetmaster

ACR_NAME=puppetmasteracr   # the name you chose in step 2
az acr build --registry $ACR_NAME --image puppetmaster-server:latest \
  --file docker/server.Dockerfile .
```

`az acr build` uploads the build context and builds the image inside ACR
itself (via ACR Tasks) — this is the Portal-friendly equivalent of
`docker build && docker push` and needs no Docker daemon in the shell.

Update the image reference:

```bash
ACR_LOGIN_SERVER=$(az acr show --name $ACR_NAME --query loginServer -o tsv)
sed -i "s|<ACR_LOGIN_SERVER>/puppetmaster-server:<TAG>|$ACR_LOGIN_SERVER/puppetmaster-server:latest|" k8s/server.yaml
```

### 6. Create the namespace and secrets

Still in Cloud Shell:

```bash
kubectl apply -f k8s/namespace.yaml

kubectl create secret generic puppetmaster-secrets -n puppetmaster \
  --from-literal=POSTGRES_PASSWORD='<choose-a-strong-password>' \
  --from-literal=DATABASE_URL='postgres://puppetmaster:<same-password>@postgres:5432/puppetmaster' \
  --from-literal=REDIS_URL='redis://redis:6379'
```

### 7. Deploy Postgres, Redis, and the server

```bash
kubectl apply -f k8s/postgres.yaml
kubectl apply -f k8s/redis.yaml
kubectl wait --for=condition=ready pod -l app=postgres -n puppetmaster --timeout=120s
kubectl wait --for=condition=ready pod -l app=redis -n puppetmaster --timeout=60s
kubectl apply -f k8s/server.yaml
```

You can watch these appear in the Portal too: open the AKS resource → left nav
**Kubernetes resources** → **Workloads**, and **Namespaces**/**Services and
ingresses** below it. That view is read/inspect-oriented (it does let you edit
a single object's YAML in place), but for applying a whole manifest set with
secrets, PVCs, and an HPA together, `kubectl apply -f` in Cloud Shell is the
reliable path — there isn't a Portal button for "apply this folder of YAML."

### 8. Expose the service (ingress)

`helm` is pre-installed in Cloud Shell, so the same commands from the CLI
guide work as-is:

```bash
helm repo add ingress-nginx https://kubernetes.github.io/ingress-nginx
helm repo update
helm install ingress-nginx ingress-nginx/ingress-nginx \
  --namespace ingress-nginx --create-namespace
```

Then edit `k8s/ingress.yaml`'s `host:` to your domain and `kubectl apply -f
k8s/ingress.yaml`. Find the ingress controller's public IP either via
`kubectl get svc ingress-nginx-controller -n ingress-nginx`, or in the Portal
under the `ingress-nginx` namespace's **Services and ingresses** page.

### 9. Verify

```bash
kubectl get all -n puppetmaster
```

Or check visually in the Portal: AKS resource → **Kubernetes resources** →
**Workloads** should show `server` (2/2 or more pods Running), `postgres`
(1/1), and `redis` (1/1).

## Notes on scaling beyond this baseline

- **Postgres/Redis in-cluster** is fine for this sizing, but if you outgrow
  it or want managed backups/HA, migrate to **Azure Database for PostgreSQL
  Flexible Server** (with the pgvector extension enabled) and **Azure Cache
  for Redis** — just update `DATABASE_URL`/`REDIS_URL` in the secret, no app
  changes needed.
- **GPU/local model inference**: not provisioned here, since the repo's
  compose file doesn't run Ollama/vLLM. If you self-host a model later, add a
  separate GPU node pool (`az aks nodepool add --node-vm-size Standard_NC*` or
  `Standard_NV*`) sized to the model's VRAM needs, and keep it isolated with
  taints so the app pods never schedule there.
- **Cost**: system pool + spot app pool + Basic ACR is the cheapest viable
  setup. Revisit the spot pool if eviction frequency becomes disruptive —
  switch `--priority Regular` for guaranteed capacity.

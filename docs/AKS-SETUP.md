# Deploying Puppetmaster to Azure Kubernetes Service (AKS)

This guide provisions an AKS cluster sized for Puppetmaster's actual workload
(a small-team, self-hosted Fastify server + Postgres/pgvector + Redis/BullMQ,
per `docker/docker-compose.yml`) and deploys the manifests in `k8s/`.

Sizing assumptions (see prior sizing discussion): 2 app replicas, ~0.25-1 vCPU /
0.5-2 GiB per server pod, single region, low network throughput, no GPU,
burstable/spot nodes acceptable for the app tier.

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

# Kubernetes Deployment for Overleaf

This directory contains Kubernetes manifests and a Helm chart for deploying Overleaf Community Edition as microservices.

## Directory Structure

```
.
├── helm/
│   └── overleaf/           # Helm chart for Overleaf
│       ├── Chart.yaml
│       ├── values.yaml
│       ├── README.md
│       ├── examples/
│       │   ├── development-values.yaml
│       │   └── production-values.yaml
│       └── templates/
│           ├── _helpers.tpl
│           ├── configmaps/
│           ├── deployments/
│           ├── secrets/
│           ├── services/
│           ├── ingress.yaml
│           ├── pvc.yaml
│           └── NOTES.txt
│
└── kubernetes/
    ├── base/               # Base Kustomize configuration
    │   ├── kustomization.yaml
    │   ├── configmap.yaml
    │   ├── secret.yaml
    │   ├── pvc.yaml
    │   ├── deployments/
    │   └── services/
    └── overlays/
        ├── development/    # Development overlay
        └── production/     # Production overlay
```

## Prerequisites

- Kubernetes 1.19+
- kubectl configured to access your cluster
- Helm 3.2.0+ (for Helm deployment)
- MongoDB cluster (can be deployed separately or use Bitnami chart)
- Redis (can be deployed separately or use Bitnami chart)

## Deployment Options

### Option 1: Using Helm (Recommended)

See the [Helm chart README](helm/overleaf/README.md) for detailed instructions.

#### Quick Start

```bash
# Add Bitnami repo for MongoDB and Redis dependencies
helm repo add bitnami https://charts.bitnami.com/bitnami
helm repo update

# Install dependencies
cd helm/overleaf
helm dependency update

# Install with development settings
helm install overleaf . -f examples/development-values.yaml --namespace overleaf --create-namespace

# Or install with production settings
helm install overleaf . -f examples/production-values.yaml --namespace overleaf --create-namespace
```

### Option 2: Using Kustomize

#### Development Deployment

```bash
# Preview the generated manifests
kubectl kustomize kubernetes/overlays/development

# Apply to cluster
kubectl apply -k kubernetes/overlays/development
```

#### Production Deployment

```bash
# First, update the secrets in kubernetes/base/secret.yaml
# Then apply the production overlay

kubectl kustomize kubernetes/overlays/production
kubectl apply -k kubernetes/overlays/production
```

### Option 3: Direct kubectl apply

```bash
# Apply base manifests directly
kubectl create namespace overleaf
kubectl apply -f kubernetes/base/
```

## Architecture

The deployment creates the following microservices:

| Service | Port | Description |
|---------|------|-------------|
| web | 3000 | Main web application and API |
| real-time | 3026 | WebSocket server for real-time collaboration |
| document-updater | 3003 | Handles document updates |
| clsi | 3013 | LaTeX compilation service |
| filestore | 3009 | File storage service |
| docstore | 3016 | Document storage |
| chat | 3010 | Chat functionality |
| contacts | 3036 | Contact management |
| notifications | 3042 | Notification service |
| project-history | 3054 | Project history tracking |
| references | 3056 | Bibliography references |
| history-v1 | 3100 | History API |
| linked-url-proxy | 3066 | External URL proxy |

## External Dependencies

### MongoDB

Overleaf requires MongoDB with replica set support. Options:

1. **Bitnami Helm Chart** (included in Helm chart dependencies):
   ```yaml
   mongodb:
     enabled: true
   ```

2. **External MongoDB**:
   ```yaml
   mongodb:
     enabled: false
     external:
       enabled: true
       url: "mongodb://user:password@host:27017/sharelatex?replicaSet=rs0"
   ```

### Redis

Overleaf requires Redis for caching and pub/sub. Options:

1. **Bitnami Helm Chart** (included in Helm chart dependencies):
   ```yaml
   redis:
     enabled: true
   ```

2. **External Redis**:
   ```yaml
   redis:
     enabled: false
     external:
       enabled: true
       host: "redis.example.com"
       port: 6379
       password: "your-password"
   ```

## Configuration

### Essential Configuration

| Variable | Description |
|----------|-------------|
| `OVERLEAF_SITE_URL` | Public URL of your Overleaf instance |
| `MONGO_URL` | MongoDB connection string |
| `REDIS_HOST` | Redis hostname |
| `OVERLEAF_SESSION_SECRET` | Secret for session encryption |

### Creating Admin User

After deployment, create an admin user:

```bash
# Get the web pod name
kubectl get pods -n overleaf -l app.kubernetes.io/component=web

# Execute create-user script
kubectl exec -it <pod-name> -n overleaf -- \
  node /overleaf/services/web/modules/server-ce-scripts/scripts/create-user \
  --admin --email=admin@example.com
```

## Scaling

### Manual Scaling

```bash
# Scale specific services
kubectl scale deployment overleaf-web --replicas=3 -n overleaf
kubectl scale deployment overleaf-clsi --replicas=5 -n overleaf
```

### Horizontal Pod Autoscaling

With Helm, enable HPA in values:

```yaml
autoscaling:
  enabled: true
  minReplicas: 2
  maxReplicas: 10
  targetCPUUtilizationPercentage: 70
```

## Storage

The deployment uses PersistentVolumeClaims for:

- `overleaf-data`: Main data storage
- `overleaf-compiles`: LaTeX compilation workspace
- `overleaf-cache`: Download cache
- `overleaf-uploads`: User uploads

For production, consider using a StorageClass with:
- `ReadWriteMany` access mode (for scaling filestore/web)
- Fast SSD storage
- Backup capabilities

## Monitoring

Each service exposes a `/health_check` endpoint for liveness and readiness probes.

For metrics, you can enable Prometheus metrics on each service (if supported).

## Troubleshooting

### Check pod status

```bash
kubectl get pods -n overleaf
kubectl describe pod <pod-name> -n overleaf
```

### View logs

```bash
# Single pod
kubectl logs <pod-name> -n overleaf

# All pods for a service
kubectl logs -l app.kubernetes.io/component=web -n overleaf

# Follow logs
kubectl logs -f <pod-name> -n overleaf
```

### Test service connectivity

```bash
# Port-forward to test a service
kubectl port-forward svc/overleaf-web 8080:3000 -n overleaf

# Test from another pod
kubectl exec -it <pod> -- wget -qO- http://overleaf-document-updater:3003/health_check
```

### Common Issues

1. **Pods in CrashLoopBackOff**
   - Check logs for errors
   - Verify MongoDB/Redis connectivity
   - Ensure secrets are correctly configured

2. **WebSocket connection failures**
   - Verify Ingress annotations for WebSocket support
   - Check real-time service is running

3. **Compile failures**
   - Check CLSI service logs
   - Verify sufficient resources for CLSI pods
   - Check TeX Live image availability

## Security Considerations

1. **Secrets Management**
   - Use external secrets manager (e.g., Vault, Sealed Secrets)
   - Never commit plain-text secrets

2. **Network Policies**
   - Enable network policies to restrict inter-service communication
   - Only expose necessary services via Ingress

3. **Pod Security**
   - Pods run as non-root by default
   - Review and apply appropriate security contexts

## License

GNU AFFERO GENERAL PUBLIC LICENSE, version 3

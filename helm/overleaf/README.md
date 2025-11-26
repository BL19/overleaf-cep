# Overleaf Helm Chart

This Helm chart deploys Overleaf Community Edition as microservices on Kubernetes.

## Overview

Overleaf is an open-source online real-time collaborative LaTeX editor. This Helm chart deploys Overleaf as separate microservices for better scalability, manageability, and resource allocation.

## Architecture

The chart deploys the following microservices:

| Service | Description | Default Port |
|---------|-------------|--------------|
| web | Main web application and API | 3000 |
| real-time | WebSocket handling for real-time collaboration | 3026 |
| document-updater | Document update operations | 3003 |
| clsi | LaTeX compilation service | 3013 |
| filestore | File storage service | 3009 |
| docstore | Document storage service | 3016 |
| chat | Chat functionality | 3010 |
| contacts | User contacts management | 3036 |
| notifications | User notifications | 3042 |
| project-history | Project history tracking | 3054 |
| references | Bibliography references | 3056 |
| history-v1 | History API v1 | 3100 |
| linked-url-proxy | External URL proxying | 3066 |

## Prerequisites

- Kubernetes 1.19+
- Helm 3.2.0+
- PV provisioner support in the underlying infrastructure (for persistence)
- MongoDB (can be deployed as a dependency)
- Redis (can be deployed as a dependency)

## Installation

### Add the Helm repository (if published)

```bash
# If chart is published to a Helm repository
helm repo add overleaf https://charts.example.com
helm repo update
```

### Install from local chart

```bash
# Install with default values
helm install overleaf ./helm/overleaf

# Install with custom values
helm install overleaf ./helm/overleaf -f my-values.yaml

# Install in a specific namespace
helm install overleaf ./helm/overleaf --namespace overleaf --create-namespace
```

### Quick Start (Local Development)

```bash
# Create a minimal values file for local development
cat > local-values.yaml <<EOF
overleaf:
  siteUrl: "http://localhost:8080"

mongodb:
  enabled: true
  auth:
    rootPassword: "rootpassword"
    password: "overleafpassword"

redis:
  enabled: true
  auth:
    password: "redispassword"

persistence:
  enabled: false
EOF

# Install
helm install overleaf ./helm/overleaf -f local-values.yaml

# Port-forward to access
kubectl port-forward svc/overleaf-web 8080:3000
```

## Configuration

### Global Configuration

| Parameter | Description | Default |
|-----------|-------------|---------|
| `global.imageRegistry` | Global Docker image registry | `""` |
| `global.imagePullSecrets` | Global Docker registry secret names | `[]` |
| `global.storageClass` | Global storage class for PVCs | `""` |

### Image Configuration

| Parameter | Description | Default |
|-----------|-------------|---------|
| `image.registry` | Image registry | `docker.io` |
| `image.repository` | Image repository | `sharelatex/sharelatex` |
| `image.tag` | Image tag | `latest` |
| `image.pullPolicy` | Image pull policy | `IfNotPresent` |

### Overleaf Configuration

| Parameter | Description | Default |
|-----------|-------------|---------|
| `overleaf.siteUrl` | Public URL for the site | `http://overleaf.local` |
| `overleaf.appName` | Application name | `Overleaf Community Edition` |
| `overleaf.adminEmail` | Admin email address | `admin@example.com` |
| `overleaf.sessionSecret` | Session secret (auto-generated if empty) | `""` |
| `overleaf.compileTimeout` | LaTeX compile timeout in seconds | `180` |
| `overleaf.filestoreBackend` | Filestore backend (fs or s3) | `fs` |

### MongoDB Configuration

| Parameter | Description | Default |
|-----------|-------------|---------|
| `mongodb.enabled` | Deploy MongoDB as dependency | `true` |
| `mongodb.auth.enabled` | Enable authentication | `true` |
| `mongodb.auth.rootPassword` | Root password | `""` |
| `mongodb.auth.database` | Database name | `sharelatex` |
| `mongodb.auth.username` | Username | `overleaf` |
| `mongodb.auth.password` | Password | `""` |
| `mongodb.external.enabled` | Use external MongoDB | `false` |
| `mongodb.external.url` | External MongoDB URL | `""` |

### Redis Configuration

| Parameter | Description | Default |
|-----------|-------------|---------|
| `redis.enabled` | Deploy Redis as dependency | `true` |
| `redis.auth.enabled` | Enable authentication | `true` |
| `redis.auth.password` | Redis password | `""` |
| `redis.external.enabled` | Use external Redis | `false` |
| `redis.external.host` | External Redis host | `""` |
| `redis.external.port` | External Redis port | `6379` |
| `redis.external.password` | External Redis password | `""` |

### Persistence Configuration

| Parameter | Description | Default |
|-----------|-------------|---------|
| `persistence.enabled` | Enable persistence | `true` |
| `persistence.storageClass` | Storage class | `""` |
| `persistence.accessModes` | Access modes | `["ReadWriteOnce"]` |
| `persistence.data.size` | Data volume size | `10Gi` |
| `persistence.compiles.size` | Compiles volume size | `5Gi` |
| `persistence.cache.size` | Cache volume size | `5Gi` |
| `persistence.uploads.size` | Uploads volume size | `5Gi` |

### Ingress Configuration

| Parameter | Description | Default |
|-----------|-------------|---------|
| `ingress.enabled` | Enable ingress | `true` |
| `ingress.className` | Ingress class name | `nginx` |
| `ingress.annotations` | Ingress annotations | See values.yaml |
| `ingress.hosts` | Ingress hosts configuration | See values.yaml |
| `ingress.tls` | Ingress TLS configuration | `[]` |

### Per-Service Configuration

Each service can be configured individually under `services.<serviceName>`:

| Parameter | Description | Default |
|-----------|-------------|---------|
| `services.<name>.enabled` | Enable the service | `true` |
| `services.<name>.replicaCount` | Number of replicas | `1` |
| `services.<name>.port` | Service port | varies |
| `services.<name>.resources` | Resource limits/requests | varies |
| `services.<name>.env` | Additional environment variables | `{}` |

## Examples

### Production Deployment with External MongoDB and Redis

```yaml
mongodb:
  enabled: false
  external:
    enabled: true
    url: "mongodb://user:password@mongodb.example.com:27017/sharelatex?replicaSet=rs0"

redis:
  enabled: false
  external:
    enabled: true
    host: "redis.example.com"
    port: 6379
    password: "redis-password"

overleaf:
  siteUrl: "https://overleaf.example.com"
  sessionSecret: "your-secure-session-secret"

ingress:
  enabled: true
  hosts:
    - host: overleaf.example.com
      paths:
        - path: /
          pathType: Prefix
          service: web
        - path: /socket.io
          pathType: Prefix
          service: real-time
  tls:
    - secretName: overleaf-tls
      hosts:
        - overleaf.example.com
```

### Using S3 for File Storage

```yaml
overleaf:
  filestoreBackend: s3
  s3:
    endpoint: "https://s3.amazonaws.com"
    accessKeyId: "your-access-key"
    secretAccessKey: "your-secret-key"
    region: "us-east-1"
    buckets:
      templateFiles: "overleaf-template-files"
      projectBlobs: "overleaf-project-blobs"
      globalBlobs: "overleaf-global-blobs"
```

### High Availability Configuration

```yaml
services:
  web:
    replicaCount: 3
  realTime:
    replicaCount: 2
  clsi:
    replicaCount: 3
    resources:
      limits:
        cpu: 4000m
        memory: 8Gi
      requests:
        cpu: 2000m
        memory: 4Gi

autoscaling:
  enabled: true
  minReplicas: 2
  maxReplicas: 10
  targetCPUUtilizationPercentage: 70
```

## Upgrading

```bash
helm upgrade overleaf ./helm/overleaf -f my-values.yaml
```

## Uninstalling

```bash
helm uninstall overleaf

# If PVCs should be deleted (data will be lost!)
kubectl delete pvc -l app.kubernetes.io/instance=overleaf
```

## Troubleshooting

### Check pod logs

```bash
kubectl logs -l app.kubernetes.io/name=overleaf,app.kubernetes.io/component=web
```

### Check service connectivity

```bash
kubectl exec -it deployment/overleaf-web -- wget -qO- http://overleaf-document-updater:3003/health_check
```

### Common Issues

1. **Pods stuck in Pending**: Check if PVCs are bound and storage class exists
2. **MongoDB connection errors**: Verify MongoDB credentials and connectivity
3. **WebSocket issues**: Ensure Ingress is configured correctly for WebSocket support

## License

This chart is released under the GNU AFFERO GENERAL PUBLIC LICENSE, version 3.

## Links

- [Overleaf GitHub Repository](https://github.com/overleaf/overleaf)
- [Overleaf Documentation](https://github.com/overleaf/overleaf/wiki)

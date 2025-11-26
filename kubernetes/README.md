# Overleaf Kubernetes Deployment

This directory contains Kubernetes deployment configurations and a Helm chart for deploying Overleaf Community Edition as microservices on Kubernetes.

## Overview

The deployment splits Overleaf into its constituent microservices:

- **web** - Main web application and API
- **real-time** - WebSocket service for real-time collaboration
- **document-updater** - Handles document update operations
- **clsi** - LaTeX compile service
- **filestore** - File storage service
- **docstore** - Document storage service
- **chat** - Chat functionality
- **contacts** - Contact management
- **notifications** - Notification service
- **project-history** - Project history tracking
- **references** - Reference management
- **history-v1** - History API v1
- **linked-url-proxy** - URL proxy for linked files

## Sandboxed Compiles on Kubernetes

One of the key features of this deployment is native Kubernetes sandboxing for LaTeX compilation. Instead of using Docker-in-Docker (sibling containers), each project gets its own isolated pod for compilation.

### How It Works

1. When a compile request comes in, the CLSI service checks if a pod already exists for that project
2. If no pod exists, a new pod is created in the sandbox namespace with:
   - Network isolation (no ingress/egress)
   - Resource limits (CPU, memory)
   - Security contexts (non-root, dropped capabilities)
   - The specified TexLive image
3. Compile files are copied to the pod via the Kubernetes API
4. The compile command is executed in the pod
5. Output files are copied back to CLSI
6. The pod stays alive for a configurable TTL (default: 20 minutes) to handle subsequent compiles for the same project
7. After the TTL expires with no activity, the pod is automatically cleaned up

### Benefits

- **True isolation**: Each project compiles in its own pod
- **Pod reuse**: The same pod is reused for subsequent compiles of the same project, avoiding scheduling overhead
- **Automatic cleanup**: Idle pods are automatically terminated after the TTL
- **Resource control**: Fine-grained CPU and memory limits per compile
- **Network isolation**: Compile pods have no network access

## Prerequisites

- Kubernetes cluster (1.19+)
- Helm 3.x
- kubectl configured to access your cluster
- Storage class for persistent volumes (or use default)

## Quick Start

### 1. Add Bitnami Helm repository (for MongoDB and Redis)

```bash
helm repo add bitnami https://charts.bitnami.com/bitnami
helm repo update
```

### 2. Create namespace

```bash
kubectl create namespace overleaf
```

### 3. Install the Helm chart

```bash
cd kubernetes/helm
helm dependency update overleaf
helm install overleaf ./overleaf -n overleaf
```

### 4. Create an admin user

After the deployment is running:

```bash
kubectl exec -it -n overleaf $(kubectl get pods -n overleaf -l "app.kubernetes.io/component=web" -o jsonpath="{.items[0].metadata.name}") -- node /overleaf/services/web/scripts/create-admin-user.js
```

## Configuration

### values.yaml

The main configuration file. Key settings include:

```yaml
# Application settings
overleaf:
  appName: "My Overleaf"
  siteUrl: "https://overleaf.example.com"
  adminEmail: "admin@example.com"
  sessionSecret: "your-secret-here"
  webApiUser: "overleaf"
  webApiPassword: "change-me"

# Sandboxed compiles
sandbox:
  enabled: true
  namespace: "overleaf-sandbox"
  texliveImage: "texlive/texlive:latest"
  podTTLMinutes: 20
  allowedImages:
    - "texlive/texlive:latest"
    - "texlive/texlive:TL2024-historic"
  resources:
    limits:
      cpu: "2"
      memory: "2Gi"
    requests:
      cpu: "500m"
      memory: "512Mi"

# Ingress
ingress:
  enabled: true
  className: "nginx"
  hosts:
    - host: overleaf.example.com
      paths:
        - path: /
          pathType: Prefix
  tls:
    - secretName: overleaf-tls
      hosts:
        - overleaf.example.com
```

### Production Configuration

For production deployments, you should:

1. Set strong secrets:
```yaml
overleaf:
  sessionSecret: "generate-a-strong-random-string"
  webApiPassword: "generate-a-strong-random-string"
```

2. Enable TLS in ingress
3. Use external MongoDB and Redis for better reliability
4. Configure persistent storage with appropriate storage classes
5. Set resource limits based on your workload

### Using External MongoDB/Redis

To use external databases instead of the bundled ones:

```yaml
mongodb:
  enabled: false

externalMongodb:
  url: "mongodb://user:pass@mongodb.example.com:27017/sharelatex?replicaSet=rs0"

redis:
  enabled: false

externalRedis:
  host: "redis.example.com"
  port: "6379"
  password: "your-redis-password"
```

## Architecture

```
                                  ┌─────────────────┐
                                  │     Ingress     │
                                  └────────┬────────┘
                                           │
                                  ┌────────▼────────┐
                                  │       Web       │
                                  └────────┬────────┘
                                           │
           ┌───────────────────────────────┼───────────────────────────────┐
           │                               │                               │
  ┌────────▼────────┐           ┌─────────▼─────────┐           ┌─────────▼─────────┐
  │   Real-time     │           │ Document-Updater  │           │      CLSI         │
  │  (WebSocket)    │           │                   │           │   (Compiles)      │
  └────────┬────────┘           └─────────┬─────────┘           └─────────┬─────────┘
           │                               │                               │
           │                               │                    ┌─────────▼─────────┐
           │                               │                    │  Sandbox Pods     │
           │                               │                    │  (Per Project)    │
           │                               │                    └───────────────────┘
           │                               │
  ┌────────┴────────────────────┬─────────┴────────────────────┐
  │                             │                               │
  │  ┌───────────────┐   ┌──────┴──────┐   ┌───────────────┐   │
  │  │   Docstore    │   │  Filestore  │   │Project-History│   │
  │  └───────┬───────┘   └──────┬──────┘   └───────┬───────┘   │
  │          │                  │                  │           │
  │          │                  │                  │           │
  │  ┌───────┴──────────────────┴──────────────────┴───────┐   │
  │  │                                                      │   │
  │  │                      MongoDB                         │   │
  │  │                                                      │   │
  │  └──────────────────────────────────────────────────────┘   │
  │                                                             │
  │  ┌──────────────────────────────────────────────────────┐   │
  │  │                       Redis                          │   │
  │  └──────────────────────────────────────────────────────┘   │
  │                                                             │
  └─────────────────────────────────────────────────────────────┘
```

## Scaling

Each service can be scaled independently:

```bash
# Scale web service
kubectl scale deployment overleaf-web -n overleaf --replicas=3

# Scale CLSI service
kubectl scale deployment overleaf-clsi -n overleaf --replicas=5
```

For CLSI scaling, consider using Horizontal Pod Autoscaler based on CPU utilization.

## Monitoring

The deployment exposes metrics endpoints on each service that can be scraped by Prometheus.

### ServiceMonitor (for Prometheus Operator)

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: overleaf
  namespace: overleaf
spec:
  selector:
    matchLabels:
      app.kubernetes.io/name: overleaf
  endpoints:
    - port: http
      path: /metrics
```

## Troubleshooting

### View logs

```bash
# Web service logs
kubectl logs -n overleaf -l app.kubernetes.io/component=web

# CLSI logs
kubectl logs -n overleaf -l app.kubernetes.io/component=clsi

# Sandbox pod logs
kubectl logs -n overleaf-sandbox <pod-name>
```

### Check sandbox pods

```bash
kubectl get pods -n overleaf-sandbox
```

### Debug compile issues

```bash
# Get list of sandbox pods
kubectl get pods -n overleaf-sandbox -l app=overleaf-sandbox

# Exec into a sandbox pod
kubectl exec -it -n overleaf-sandbox <pod-name> -- /bin/sh
```

## License

This deployment configuration is part of the Overleaf project and is licensed under the GNU AGPL v3.

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

### Architecture

Each sandbox pod runs the **sandbox-agent**, a lightweight HTTP server that:
- Receives project files from CLSI via HTTP
- Executes LaTeX compilation commands
- Streams output files back to CLSI
- Stays alive for pod reuse (no pod scheduling overhead for subsequent compiles)

```
┌─────────────────────────────────────────────────────────────────┐
│                        CLSI Service                             │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │                  KubernetesRunner                        │   │
│  │  - Creates/reuses sandbox pods                           │   │
│  │  - Uploads files via HTTP POST /upload                   │   │
│  │  - Triggers compile via HTTP POST /compile               │   │
│  │  - Downloads outputs via HTTP GET /download              │   │
│  └────────────────────────┬────────────────────────────────┘   │
└───────────────────────────┼─────────────────────────────────────┘
                            │ HTTP (port 8080)
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Sandbox Namespace                            │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │              Sandbox Pod (per project)                   │   │
│  │  ┌─────────────────────────────────────────────────┐    │   │
│  │  │              sandbox-agent                       │    │   │
│  │  │  - HTTP server listening on port 8080            │    │   │
│  │  │  - Receives files → /compile directory           │    │   │
│  │  │  - Runs latexmk/pdflatex commands                │    │   │
│  │  │  - Sends back .pdf, .log, .aux files             │    │   │
│  │  │  - Stays alive for 20min (configurable)          │    │   │
│  │  └─────────────────────────────────────────────────┘    │   │
│  │  ┌─────────────────────────────────────────────────┐    │   │
│  │  │              TexLive Installation                │    │   │
│  │  │  - Full TexLive distribution                     │    │   │
│  │  │  - Runs inside the same container                │    │   │
│  │  └─────────────────────────────────────────────────┘    │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│  Network Policy: No ingress/egress (isolated)                   │
└─────────────────────────────────────────────────────────────────┘
```

### How It Works

1. When a compile request comes in, the CLSI service checks if a pod already exists for that project
2. If no pod exists, a new pod is created in the sandbox namespace with:
   - The sandbox-agent running as the main process
   - Network isolation (no ingress/egress except from CLSI)
   - Resource limits (CPU, memory)
   - Security contexts (non-root, dropped capabilities, read-only root filesystem)
3. CLSI uploads project files to the pod via HTTP POST to `/upload`
4. CLSI triggers compilation via HTTP POST to `/compile` with the command to run
5. The sandbox-agent executes the compile command and returns stdout/stderr
6. CLSI downloads output files via HTTP GET from `/download`
7. The pod stays alive for a configurable TTL (default: 20 minutes) to handle subsequent compiles
8. After the TTL expires with no activity, the pod is automatically cleaned up

### Benefits

- **True isolation**: Each project compiles in its own pod
- **Pod reuse**: The same pod is reused for subsequent compiles of the same project, avoiding scheduling overhead
- **Efficient file transfer**: HTTP-based file transfer is faster than kubectl exec
- **Automatic cleanup**: Idle pods are automatically terminated after the TTL
- **Resource control**: Fine-grained CPU and memory limits per compile
- **Network isolation**: Compile pods have no network access

### Building the Sandbox Image

The sandbox image includes TexLive and the sandbox-agent. Build it with:

```bash
docker build -f kubernetes/dockerfiles/Dockerfile.sandbox \
  --build-arg TEXLIVE_IMAGE=texlive/texlive:latest \
  -t overleaf/sandbox:latest .
```

For different TexLive versions:

```bash
# TexLive 2024
docker build -f kubernetes/dockerfiles/Dockerfile.sandbox \
  --build-arg TEXLIVE_IMAGE=texlive/texlive:TL2024-historic \
  -t overleaf/sandbox:TL2024 .

# TexLive 2023
docker build -f kubernetes/dockerfiles/Dockerfile.sandbox \
  --build-arg TEXLIVE_IMAGE=texlive/texlive:TL2023-historic \
  -t overleaf/sandbox:TL2023 .
```

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

### 3. Build and push the sandbox image

```bash
docker build -f kubernetes/dockerfiles/Dockerfile.sandbox \
  -t your-registry/overleaf-sandbox:latest .
docker push your-registry/overleaf-sandbox:latest
```

### 4. Install the Helm chart

```bash
cd kubernetes/helm
helm dependency update overleaf
helm install overleaf ./overleaf -n overleaf \
  --set sandbox.image=your-registry/overleaf-sandbox:latest \
  --set sandbox.agentSecret=$(openssl rand -hex 32)
```

> **Note**: The `sandbox.agentSecret` is used to authenticate communication between CLSI and the sandbox pods. This is important for security on shared VPCs. If not set, a random secret is generated, but it's recommended to set it explicitly for production.

### 5. Create an admin user

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
  image: "overleaf/sandbox:latest"
  # IMPORTANT: Set this for security on shared VPCs
  agentSecret: "your-secure-secret-here"
  podTTLMinutes: 20
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

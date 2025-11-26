/**
 * KubernetesRunner - Runs LaTeX compilations in isolated Kubernetes pods
 * 
 * This module replaces DockerRunner for Kubernetes deployments.
 * Each project gets its own pod that stays alive for a configurable TTL
 * since the last compile, allowing pod reuse for efficiency.
 * 
 * Architecture:
 * - Each project gets a dedicated pod running the sandbox-agent
 * - The sandbox-agent is a lightweight HTTP server that handles:
 *   - File uploads from CLSI
 *   - Compilation command execution
 *   - File downloads back to CLSI
 * - Pods stay alive for podTTLMinutes (default 20) after the last compile
 * - Subsequent compiles reuse the same pod (no scheduling overhead)
 * - Communication is secured with a shared secret token
 */

const { promisify } = require('node:util')
const Settings = require('@overleaf/settings')
const logger = require('@overleaf/logger')
const crypto = require('node:crypto')
const Path = require('node:path')
const fs = require('node:fs').promises
const http = require('node:http')
const https = require('node:https')

// Kubernetes client
const k8s = require('@kubernetes/client-node')

const kc = new k8s.KubeConfig()
kc.loadFromCluster()

const k8sApi = kc.makeApiClient(k8s.CoreV1Api)

// Configuration from environment
const SANDBOX_NAMESPACE = process.env.SANDBOX_NAMESPACE || 'overleaf-sandbox'
const POD_TTL_MINUTES = parseInt(process.env.SANDBOX_POD_TTL_MINUTES, 10) || 20
const POD_TTL_MS = POD_TTL_MINUTES * 60 * 1000
const SANDBOX_AGENT_PORT = parseInt(process.env.SANDBOX_AGENT_PORT, 10) || 8080
const SANDBOX_IMAGE = process.env.SANDBOX_IMAGE || 'overleaf/sandbox:latest'
// Shared secret for authenticating with sandbox agents
const SANDBOX_AGENT_SECRET = process.env.SANDBOX_AGENT_SECRET || crypto.randomBytes(32).toString('hex')

// Track active pods and their IP addresses
const activePods = new Map() // podName -> { ip, lastActivity }

// Pod activity tracking
function updatePodActivity(podName, podIp) {
  activePods.set(podName, { ip: podIp, lastActivity: Date.now() })
}

function getPodInfo(podName) {
  return activePods.get(podName)
}

function getPodLastActivity(podName) {
  return activePods.get(podName)?.lastActivity || 0
}

logger.debug({ namespace: SANDBOX_NAMESPACE, ttlMinutes: POD_TTL_MINUTES }, 'using kubernetes runner')

const KubernetesRunner = {
  /**
   * Run a command in an isolated Kubernetes pod for a specific project
   */
  run(
    projectId,
    command,
    directory,
    image,
    timeout,
    environment,
    compileGroup,
    callback
  ) {
    // Ensure command paths are correct
    command = command.map(arg =>
      arg.toString().replace('$COMPILE_DIR', '/compile')
    )

    // Default image if not specified
    if (image == null) {
      image = Settings.clsi?.docker?.image || process.env.SANDBOX_TEXLIVE_IMAGE || 'texlive/texlive:latest'
    }

    // Validate allowed images
    const allowedImages = Settings.clsi?.docker?.allowedImages || 
      (process.env.SANDBOX_ALLOWED_IMAGES ? process.env.SANDBOX_ALLOWED_IMAGES.split(',') : null)
    
    if (allowedImages && !allowedImages.includes(image)) {
      return callback(new Error('image not allowed'))
    }

    // Generate unique pod name based on project ID only
    // This ensures the same pod is reused for all compiles of the same project
    const podName = KubernetesRunner._generatePodName(projectId)
    
    logger.debug({ projectId, podName, image, command }, 'running kubernetes compile')

    KubernetesRunner._runInPod(
      podName,
      projectId,
      command,
      directory,
      image,
      timeout,
      environment,
      compileGroup,
      callback
    )

    // Return pod name for potential kill operations
    return podName
  },

  /**
   * Generate a unique pod name for a project
   * Uses only projectId to ensure the same pod is reused for all compiles
   * of the same project, enabling efficient pod reuse
   */
  _generatePodName(projectId) {
    // Use only projectId for consistent pod naming across compiles
    // This ensures the same pod is reused for subsequent compiles of the same project
    return `compile-${projectId}`.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 63)
  },

  /**
   * Run command in a pod, creating it if necessary
   * Uses HTTP communication with the sandbox-agent running in the pod
   */
  async _runInPod(
    podName,
    projectId,
    command,
    directory,
    image,
    timeout,
    environment,
    compileGroup,
    callback
  ) {
    try {
      // Check if pod already exists and is running
      let podInfo = await KubernetesRunner._getExistingPod(podName)
      
      if (!podInfo) {
        // Create new pod with sandbox agent
        podInfo = await KubernetesRunner._createPod(podName, projectId, image, environment, compileGroup)
        await KubernetesRunner._waitForPodReady(podName)
        // Get pod IP after it's ready
        podInfo = await KubernetesRunner._getExistingPod(podName)
      }

      const podIp = podInfo.status?.podIP
      if (!podIp) {
        throw new Error(`Pod ${podName} has no IP address`)
      }

      // Update activity timestamp with pod IP
      updatePodActivity(podName, podIp)

      // Upload compile files to pod via HTTP
      await KubernetesRunner._uploadFilesToPod(podIp, directory)

      // Execute the compile command via HTTP
      const result = await KubernetesRunner._executeCompileViaAgent(podIp, command, timeout)

      // Download output files from pod via HTTP
      await KubernetesRunner._downloadFilesFromPod(podIp, directory)

      // Update activity again after successful compile
      updatePodActivity(podName, podIp)

      callback(null, result)
    } catch (error) {
      logger.error({ err: error, podName, projectId }, 'kubernetes compile error')
      
      if (error.timedout) {
        // Kill the pod on timeout
        await KubernetesRunner._deletePod(podName)
      }
      
      callback(error)
    }
  },

  /**
   * Get an existing pod if it's running
   */
  async _getExistingPod(podName) {
    try {
      const response = await k8sApi.readNamespacedPod({
        name: podName,
        namespace: SANDBOX_NAMESPACE
      })
      // The response contains the pod data directly in newer client versions
      const pod = response.body || response

      // Check if pod is in running state
      if (pod.status?.phase === 'Running') {
        return pod
      }

      // If pod is not running, delete it and return null
      if (pod.status?.phase === 'Failed' || pod.status?.phase === 'Succeeded') {
        await KubernetesRunner._deletePod(podName)
      }

      return null
    } catch (error) {
      if (error.statusCode === 404 || error.response?.statusCode === 404) {
        return null
      }
      throw error
    }
  },

  /**
   * Create a new sandbox pod
   */
  async _createPod(podName, projectId, image, environment, compileGroup) {
    const podSpec = KubernetesRunner._buildPodSpec(podName, projectId, image, environment, compileGroup)
    
    logger.debug({ podName, image }, 'creating sandbox pod')
    
    const response = await k8sApi.createNamespacedPod({
      namespace: SANDBOX_NAMESPACE,
      body: podSpec
    })
    
    // Return the pod data (handle both old and new client API)
    return response.body || response
  },

  /**
   * Build the pod specification with sandbox-agent
   */
  _buildPodSpec(podName, projectId, image, environment, compileGroup) {
    // Build environment variables for the sandbox agent
    const envVars = [
      { name: 'HOME', value: '/home/texlive' },
      { name: 'COMPILE_DIR', value: '/compile' },
      { name: 'SANDBOX_AGENT_PORT', value: String(SANDBOX_AGENT_PORT) },
      { name: 'IDLE_TIMEOUT_MS', value: String(POD_TTL_MS) },
      // Authentication secret for sandbox agent
      { name: 'SANDBOX_AGENT_SECRET', value: SANDBOX_AGENT_SECRET },
    ]

    // Add custom environment variables
    if (environment) {
      for (const [key, value] of Object.entries(environment)) {
        envVars.push({ name: key, value: String(value) })
      }
    }

    // Set PATH based on requested TexLive image year
    const match = image.match(/:([0-9]+)\.[0-9]+|:TL([0-9]+)/)
    const year = match ? match[1] || match[2] : 'rolling'
    envVars.push({
      name: 'PATH',
      value: `/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/local/texlive/${year}/bin/x86_64-linux/`
    })

    // Resource limits from settings
    const cpuLimit = process.env.SANDBOX_CPU_LIMIT || '2'
    const memoryLimit = process.env.SANDBOX_MEMORY_LIMIT || '2Gi'
    const cpuRequest = process.env.SANDBOX_CPU_REQUEST || '500m'
    const memoryRequest = process.env.SANDBOX_MEMORY_REQUEST || '512Mi'

    // Use sandbox image with agent, or fall back to configured sandbox image
    // The sandbox image should be built from Dockerfile.sandbox with the desired TexLive version
    const sandboxImage = process.env.SANDBOX_IMAGE || `overleaf/sandbox:${year}`

    return {
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: {
        name: podName,
        namespace: SANDBOX_NAMESPACE,
        labels: {
          app: 'overleaf-sandbox',
          projectId: projectId,
          'app.kubernetes.io/managed-by': 'overleaf-clsi',
        },
        annotations: {
          'overleaf.io/project-id': projectId,
          'overleaf.io/created-at': new Date().toISOString(),
          'overleaf.io/texlive-image': image,
        }
      },
      spec: {
        // Restart on failure to keep agent running
        restartPolicy: 'OnFailure',
        // Terminate after TTL (with buffer)
        activeDeadlineSeconds: Math.floor(POD_TTL_MS / 1000) + 3600,
        // Security context
        securityContext: {
          runAsNonRoot: true,
          runAsUser: 1000,
          runAsGroup: 1000,
          fsGroup: 1000,
        },
        // No service account needed
        automountServiceAccountToken: false,
        // Sandbox agent container
        containers: [{
          name: 'sandbox-agent',
          image: sandboxImage,
          imagePullPolicy: 'IfNotPresent',
          ports: [{
            name: 'http',
            containerPort: SANDBOX_AGENT_PORT,
            protocol: 'TCP'
          }],
          env: envVars,
          resources: {
            limits: {
              cpu: cpuLimit,
              memory: memoryLimit,
            },
            requests: {
              cpu: cpuRequest,
              memory: memoryRequest,
            }
          },
          securityContext: {
            allowPrivilegeEscalation: false,
            readOnlyRootFilesystem: true,
            capabilities: {
              drop: ['ALL']
            }
          },
          volumeMounts: [
            {
              name: 'compile-dir',
              mountPath: '/compile'
            },
            {
              name: 'tmp',
              mountPath: '/tmp'
            },
            {
              name: 'home',
              mountPath: '/home/texlive'
            }
          ],
          livenessProbe: {
            httpGet: {
              path: '/health',
              port: SANDBOX_AGENT_PORT
            },
            initialDelaySeconds: 5,
            periodSeconds: 30,
            timeoutSeconds: 5
          },
          readinessProbe: {
            httpGet: {
              path: '/health',
              port: SANDBOX_AGENT_PORT
            },
            initialDelaySeconds: 2,
            periodSeconds: 5,
            timeoutSeconds: 3
          }
        }],
        volumes: [
          {
            name: 'compile-dir',
            emptyDir: {}
          },
          {
            name: 'tmp',
            emptyDir: {
              sizeLimit: '100Mi'
            }
          },
          {
            name: 'home',
            emptyDir: {
              sizeLimit: '50Mi'
            }
          }
        ],
        // No network access for sandboxed compiles
        dnsPolicy: 'None',
        hostNetwork: false,
      }
    }
  },

  /**
   * Wait for pod to be ready (checks both Kubernetes status and agent health)
   */
  async _waitForPodReady(podName, timeoutMs = 60000) {
    const startTime = Date.now()
    
    while (Date.now() - startTime < timeoutMs) {
      try {
        const response = await k8sApi.readNamespacedPod({
          name: podName,
          namespace: SANDBOX_NAMESPACE
        })
        // Handle both old and new client API
        const pod = response.body || response

        if (pod.status?.phase === 'Running') {
          // Check if sandbox-agent container is ready
          const containerStatus = pod.status.containerStatuses?.find(cs => cs.name === 'sandbox-agent')
          if (containerStatus?.ready && pod.status?.podIP) {
            // Also verify agent is responding
            try {
              await KubernetesRunner._httpRequest(pod.status.podIP, '/health', 'GET', null, 5000)
              logger.debug({ podName, podIp: pod.status.podIP }, 'pod and agent are ready')
              return
            } catch (healthError) {
              // Agent not ready yet, continue waiting
              logger.debug({ podName, err: healthError.message }, 'agent health check failed, retrying')
            }
          }
        }

        if (pod.status?.phase === 'Failed') {
          throw new Error(`Pod ${podName} failed to start`)
        }
      } catch (error) {
        if (error.statusCode !== 404 && error.response?.statusCode !== 404) {
          throw error
        }
      }

      // Wait before checking again
      await new Promise(resolve => setTimeout(resolve, 1000))
    }

    throw new Error(`Timeout waiting for pod ${podName} to be ready`)
  },

  /**
   * Make an HTTP request to the sandbox agent
   * Includes authentication token in the Authorization header
   */
  _httpRequest(podIp, path, method, body, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const options = {
        hostname: podIp,
        port: SANDBOX_AGENT_PORT,
        path: path,
        method: method,
        timeout: timeoutMs,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${SANDBOX_AGENT_SECRET}`
        }
      }

      const req = http.request(options, (res) => {
        let data = ''
        res.on('data', chunk => { data += chunk })
        res.on('end', () => {
          try {
            const json = JSON.parse(data)
            if (res.statusCode >= 400) {
              const err = new Error(json.error || `HTTP ${res.statusCode}`)
              err.statusCode = res.statusCode
              reject(err)
            } else {
              resolve(json)
            }
          } catch (e) {
            reject(new Error(`Invalid JSON response: ${data.slice(0, 100)}`))
          }
        })
      })

      req.on('error', reject)
      req.on('timeout', () => {
        req.destroy()
        reject(new Error('Request timeout'))
      })

      if (body) {
        req.write(JSON.stringify(body))
      }
      req.end()
    })
  },

  /**
   * Upload files to pod via HTTP
   */
  async _uploadFilesToPod(podIp, localDir) {
    const files = {}
    await KubernetesRunner._collectFilesForUpload(localDir, '', files)
    
    logger.debug({ podIp, fileCount: Object.keys(files).length }, 'uploading files to pod')
    
    const response = await KubernetesRunner._httpRequest(podIp, '/upload', 'POST', { files }, 60000)
    
    if (!response.success) {
      throw new Error(`Failed to upload files: ${response.error}`)
    }
    
    return response
  },

  /**
   * Collect files recursively for upload
   */
  async _collectFilesForUpload(dir, basePath, files) {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    
    for (const entry of entries) {
      // Skip files with potentially dangerous names
      if (entry.name.includes('/') || entry.name.includes('\0') || entry.name.startsWith('.')) {
        continue
      }
      
      const localPath = Path.join(dir, entry.name)
      const remotePath = basePath ? `${basePath}/${entry.name}` : entry.name
      
      if (entry.isDirectory()) {
        await KubernetesRunner._collectFilesForUpload(localPath, remotePath, files)
      } else {
        const content = await fs.readFile(localPath)
        files[remotePath] = content.toString('base64')
      }
    }
  },

  /**
   * Execute compile command via HTTP agent
   */
  async _executeCompileViaAgent(podIp, command, timeout) {
    logger.debug({ podIp, command }, 'executing compile via agent')
    
    const response = await KubernetesRunner._httpRequest(
      podIp,
      '/compile',
      'POST',
      { command, timeout },
      timeout + 5000 // Add buffer for HTTP overhead
    )
    
    if (response.timedOut) {
      const err = new Error('container timed out')
      err.timedout = true
      throw err
    }
    
    return {
      stdout: response.stdout || '',
      stderr: response.stderr || '',
      exitCode: response.exitCode
    }
  },

  /**
   * Download output files from pod via HTTP
   */
  async _downloadFilesFromPod(podIp, localDir) {
    // List files with output extensions
    const outputExtensions = ['.pdf', '.log', '.aux', '.synctex.gz', '.blg', '.bbl', '.out', '.toc']
    const listResponse = await KubernetesRunner._httpRequest(
      podIp,
      `/files?extensions=${outputExtensions.join(',')}`,
      'GET',
      null,
      30000
    )
    
    logger.debug({ podIp, fileCount: listResponse.files?.length }, 'downloading output files')
    
    for (const fileInfo of listResponse.files || []) {
      // Download each file
      const downloadResponse = await KubernetesRunner._httpRequest(
        podIp,
        `/download?path=${encodeURIComponent(fileInfo.path)}`,
        'GET',
        null,
        60000
      )
      
      if (downloadResponse.content) {
        const localPath = Path.join(localDir, Path.basename(fileInfo.path))
        const content = Buffer.from(downloadResponse.content, 'base64')
        await fs.writeFile(localPath, content)
      }
    }
  },

  /**
   * Kill a running compile by deleting the pod
   */
  kill(podName, callback) {
    logger.debug({ podName }, 'killing sandbox pod')
    
    KubernetesRunner._deletePod(podName)
      .then(() => callback())
      .catch(callback)
  },

  /**
   * Delete a pod
   */
  async _deletePod(podName) {
    try {
      await k8sApi.deleteNamespacedPod({
        name: podName,
        namespace: SANDBOX_NAMESPACE,
        gracePeriodSeconds: 0
      })
      activePods.delete(podName)
      logger.debug({ podName }, 'deleted sandbox pod')
    } catch (error) {
      if (error.statusCode !== 404) {
        logger.error({ err: error, podName }, 'error deleting pod')
        throw error
      }
    }
  },

  /**
   * Destroy container/pod for cleanup
   */
  destroyContainer(containerName, containerId, shouldForce, callback) {
    KubernetesRunner._deletePod(containerName)
      .then(() => callback())
      .catch(callback)
  },

  /**
   * Clean up expired pods
   */
  async destroyOldPods() {
    try {
      const response = await k8sApi.listNamespacedPod({
        namespace: SANDBOX_NAMESPACE,
        labelSelector: 'app=overleaf-sandbox'
      })
      
      const now = Date.now()
      
      for (const pod of response.items) {
        const podName = pod.metadata.name
        const lastActivity = getPodLastActivity(podName)
        
        // Calculate age
        const createdAt = new Date(pod.metadata.creationTimestamp).getTime()
        const age = now - (lastActivity || createdAt)
        
        if (age > POD_TTL_MS) {
          logger.debug({ podName, age: age / 1000 / 60 }, 'destroying expired pod')
          await KubernetesRunner._deletePod(podName)
        }
      }
    } catch (error) {
      logger.error({ err: error }, 'error cleaning up old pods')
    }
  },

  /**
   * Start the pod cleanup monitor
   */
  startPodMonitor() {
    logger.debug({ ttlMinutes: POD_TTL_MINUTES }, 'starting pod expiry monitor')
    
    // Run cleanup every 5 minutes
    setInterval(() => {
      KubernetesRunner.destroyOldPods().catch(err => {
        logger.error({ err }, 'failed to destroy old pods')
      })
    }, 5 * 60 * 1000)
  },

  /**
   * Whether synctex can run in output directory
   */
  canRunSyncTeXInOutputDir() {
    return true
  }
}

// Start the pod monitor
KubernetesRunner.startPodMonitor()

module.exports = KubernetesRunner
module.exports.promises = {
  run: promisify(KubernetesRunner.run),
  kill: promisify(KubernetesRunner.kill),
}

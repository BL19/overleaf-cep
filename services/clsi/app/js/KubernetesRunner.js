/**
 * KubernetesRunner - Runs LaTeX compilations in isolated Kubernetes pods
 * 
 * This module replaces DockerRunner for Kubernetes deployments.
 * Each project gets its own pod that stays alive for a configurable TTL
 * since the last compile, allowing pod reuse for efficiency.
 */

const { promisify } = require('node:util')
const Settings = require('@overleaf/settings')
const logger = require('@overleaf/logger')
const crypto = require('node:crypto')
const Path = require('node:path')
const fs = require('node:fs').promises
const _ = require('lodash')

// Kubernetes client
const k8s = require('@kubernetes/client-node')

const kc = new k8s.KubeConfig()
kc.loadFromCluster()

const k8sApi = kc.makeApiClient(k8s.CoreV1Api)
const k8sExec = new k8s.Exec(kc)

// Configuration from environment
const SANDBOX_NAMESPACE = process.env.SANDBOX_NAMESPACE || 'overleaf-sandbox'
const POD_TTL_MINUTES = parseInt(process.env.SANDBOX_POD_TTL_MINUTES, 10) || 20
const POD_TTL_MS = POD_TTL_MINUTES * 60 * 1000

// Track active pods and their last activity
const activePods = new Map()

// Pod activity tracking
function updatePodActivity(podName) {
  activePods.set(podName, Date.now())
}

function getPodLastActivity(podName) {
  return activePods.get(podName) || 0
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

    // Generate unique pod name based on project and user
    const podName = KubernetesRunner._generatePodName(projectId, directory)
    
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
   */
  _generatePodName(projectId, directory) {
    // Include directory info to handle per-user containers
    const dirHash = crypto.createHash('md5').update(directory).digest('hex').slice(0, 8)
    return `compile-${projectId}-${dirHash}`.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 63)
  },

  /**
   * Run command in a pod, creating it if necessary
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
      let pod = await KubernetesRunner._getExistingPod(podName)
      
      if (!pod) {
        // Create new pod
        pod = await KubernetesRunner._createPod(podName, projectId, image, environment, compileGroup)
        await KubernetesRunner._waitForPodReady(podName)
      }

      // Update activity timestamp
      updatePodActivity(podName)

      // Copy compile files to pod
      await KubernetesRunner._copyFilesToPod(podName, directory)

      // Execute the compile command
      const result = await KubernetesRunner._executeCommand(podName, command, timeout)

      // Copy output files back
      await KubernetesRunner._copyFilesFromPod(podName, directory)

      // Update activity again after successful compile
      updatePodActivity(podName)

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
      const pod = response

      // Check if pod is in running state
      if (pod.status.phase === 'Running') {
        return pod
      }

      // If pod is not running, delete it and return null
      if (pod.status.phase === 'Failed' || pod.status.phase === 'Succeeded') {
        await KubernetesRunner._deletePod(podName)
      }

      return null
    } catch (error) {
      if (error.statusCode === 404) {
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
    
    return response
  },

  /**
   * Build the pod specification
   */
  _buildPodSpec(podName, projectId, image, environment, compileGroup) {
    // Build environment variables
    const envVars = [
      { name: 'HOME', value: '/tmp' },
      { name: 'CLSI', value: '1' },
    ]

    // Add custom environment variables
    if (environment) {
      for (const [key, value] of Object.entries(environment)) {
        envVars.push({ name: key, value: String(value) })
      }
    }

    // Set PATH based on image year
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
        }
      },
      spec: {
        // Don't restart on failure
        restartPolicy: 'Never',
        // Terminate after TTL
        activeDeadlineSeconds: POD_TTL_MS / 1000 + 3600, // Add extra hour as buffer
        // Security context
        securityContext: {
          runAsNonRoot: true,
          runAsUser: 1000,
          runAsGroup: 1000,
          fsGroup: 1000,
        },
        // No service account needed - network isolated
        automountServiceAccountToken: false,
        // Compile container
        containers: [{
          name: 'compile',
          image: image,
          imagePullPolicy: 'IfNotPresent',
          // Keep container running
          command: ['sleep', 'infinity'],
          workingDir: '/compile',
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
            readOnlyRootFilesystem: false,
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
            }
          ]
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
          }
        ],
        // No network access for sandboxed compiles
        dnsPolicy: 'None',
        hostNetwork: false,
      }
    }
  },

  /**
   * Wait for pod to be ready
   */
  async _waitForPodReady(podName, timeoutMs = 60000) {
    const startTime = Date.now()
    
    while (Date.now() - startTime < timeoutMs) {
      try {
        const response = await k8sApi.readNamespacedPod({
          name: podName,
          namespace: SANDBOX_NAMESPACE
        })
        const pod = response

        if (pod.status.phase === 'Running') {
          // Check if container is ready
          const containerStatus = pod.status.containerStatuses?.find(cs => cs.name === 'compile')
          if (containerStatus?.ready) {
            logger.debug({ podName }, 'pod is ready')
            return
          }
        }

        if (pod.status.phase === 'Failed') {
          throw new Error(`Pod ${podName} failed to start`)
        }
      } catch (error) {
        if (error.statusCode !== 404) {
          throw error
        }
      }

      // Wait before checking again
      await new Promise(resolve => setTimeout(resolve, 1000))
    }

    throw new Error(`Timeout waiting for pod ${podName} to be ready`)
  },

  /**
   * Copy files from local directory to pod
   */
  async _copyFilesToPod(podName, localDir) {
    // Use kubectl cp equivalent - tar and stream
    const files = await fs.readdir(localDir, { withFileTypes: true })
    
    for (const file of files) {
      const localPath = Path.join(localDir, file.name)
      const remotePath = `/compile/${file.name}`
      
      if (file.isDirectory()) {
        // Recursively copy directory
        await KubernetesRunner._copyDirToPod(podName, localPath, remotePath)
      } else {
        // Copy file
        await KubernetesRunner._copyFileToPod(podName, localPath, remotePath)
      }
    }
  },

  /**
   * Copy a single file to pod
   */
  async _copyFileToPod(podName, localPath, remotePath) {
    const content = await fs.readFile(localPath)
    const base64Content = content.toString('base64')
    
    // Use exec to write file
    const command = ['sh', '-c', `echo "${base64Content}" | base64 -d > ${remotePath}`]
    
    await KubernetesRunner._execInPod(podName, command)
  },

  /**
   * Copy directory to pod
   */
  async _copyDirToPod(podName, localDir, remoteDir) {
    // Create directory
    await KubernetesRunner._execInPod(podName, ['mkdir', '-p', remoteDir])
    
    const files = await fs.readdir(localDir, { withFileTypes: true })
    
    for (const file of files) {
      const localPath = Path.join(localDir, file.name)
      const remotePath = `${remoteDir}/${file.name}`
      
      if (file.isDirectory()) {
        await KubernetesRunner._copyDirToPod(podName, localPath, remotePath)
      } else {
        await KubernetesRunner._copyFileToPod(podName, localPath, remotePath)
      }
    }
  },

  /**
   * Copy files from pod to local directory
   */
  async _copyFilesFromPod(podName, localDir) {
    // Get list of output files
    const listResult = await KubernetesRunner._execInPod(podName, ['ls', '-la', '/compile'])
    
    // Copy output files (pdf, log, aux, etc.)
    const outputExtensions = ['.pdf', '.log', '.aux', '.synctex.gz', '.blg', '.bbl', '.out', '.toc']
    
    // Get file list
    const filesResult = await KubernetesRunner._execInPod(podName, ['find', '/compile', '-maxdepth', '2', '-type', 'f'])
    const files = filesResult.stdout.trim().split('\n').filter(Boolean)
    
    for (const remotePath of files) {
      const fileName = Path.basename(remotePath)
      const ext = Path.extname(fileName).toLowerCase()
      
      if (outputExtensions.some(e => fileName.endsWith(e)) || fileName === 'output.pdf') {
        const localPath = Path.join(localDir, fileName)
        await KubernetesRunner._copyFileFromPod(podName, remotePath, localPath)
      }
    }
  },

  /**
   * Copy file from pod to local
   */
  async _copyFileFromPod(podName, remotePath, localPath) {
    // Read file as base64 from pod
    const result = await KubernetesRunner._execInPod(podName, ['base64', '-w', '0', remotePath])
    
    if (result.stdout) {
      const content = Buffer.from(result.stdout, 'base64')
      await fs.writeFile(localPath, content)
    }
  },

  /**
   * Execute command in pod
   */
  async _executeCommand(podName, command, timeout) {
    return new Promise((resolve, reject) => {
      let timedOut = false
      const timeoutId = setTimeout(() => {
        timedOut = true
        const err = new Error('container timed out')
        err.timedout = true
        reject(err)
      }, timeout)

      KubernetesRunner._execInPod(podName, command)
        .then(result => {
          clearTimeout(timeoutId)
          if (timedOut) return
          resolve(result)
        })
        .catch(error => {
          clearTimeout(timeoutId)
          if (timedOut) return
          reject(error)
        })
    })
  },

  /**
   * Execute command in pod and return output
   */
  _execInPod(podName, command) {
    return new Promise((resolve, reject) => {
      let stdout = ''
      let stderr = ''

      const execInstance = new k8s.Exec(kc)
      
      execInstance.exec(
        SANDBOX_NAMESPACE,
        podName,
        'compile',
        command,
        // Streams
        {
          write: (data) => { stdout += data },
        },
        {
          write: (data) => { stderr += data },
        },
        null, // stdin
        false, // tty
        (status) => {
          if (status.status === 'Success') {
            resolve({ stdout, stderr, exitCode: 0 })
          } else {
            // Check exit code
            const exitCode = status.details?.causes?.find(c => c.reason === 'ExitCode')?.message
            if (exitCode === '0' || !exitCode) {
              resolve({ stdout, stderr, exitCode: parseInt(exitCode, 10) || 0 })
            } else {
              const err = new Error(`Command failed with exit code ${exitCode}`)
              err.exitCode = parseInt(exitCode, 10)
              err.stdout = stdout
              err.stderr = stderr
              reject(err)
            }
          }
        }
      ).catch(reject)
    })
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

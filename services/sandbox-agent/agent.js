/**
 * Sandbox Agent - Lightweight HTTP server running in TexLive sandbox pods
 * 
 * This agent runs inside each sandbox pod and handles:
 * - Receiving project files from CLSI
 * - Executing LaTeX compilation commands
 * - Sending back compiled outputs
 * - Keeping the pod alive for reuse
 * 
 * The agent is designed to be minimal with no external dependencies
 * to keep the sandbox container lightweight.
 * 
 * Security: All requests must include a valid Bearer token in the
 * Authorization header matching the SANDBOX_AGENT_SECRET environment variable.
 */

const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')
const crypto = require('node:crypto')

// Configuration
const PORT = parseInt(process.env.SANDBOX_AGENT_PORT, 10) || 8080
const COMPILE_DIR = process.env.COMPILE_DIR || '/compile'
const MAX_OUTPUT_SIZE = parseInt(process.env.MAX_OUTPUT_SIZE, 10) || 10 * 1024 * 1024 // 10MB
const IDLE_TIMEOUT_MS = parseInt(process.env.IDLE_TIMEOUT_MS, 10) || 20 * 60 * 1000 // 20 minutes
// Authentication secret - must match the one used by CLSI
const AGENT_SECRET = process.env.SANDBOX_AGENT_SECRET

// Track last activity for idle timeout
let lastActivity = Date.now()

function updateActivity() {
  lastActivity = Date.now()
}

/**
 * Verify authentication token from Authorization header
 * Uses constant-time comparison to prevent timing attacks
 */
function verifyAuth(req) {
  if (!AGENT_SECRET) {
    // If no secret is configured, allow all requests (for development)
    console.warn('WARNING: SANDBOX_AGENT_SECRET not set, authentication disabled')
    return true
  }
  
  const authHeader = req.headers['authorization']
  if (!authHeader) {
    return false
  }
  
  const match = authHeader.match(/^Bearer\s+(.+)$/i)
  if (!match) {
    return false
  }
  
  const token = match[1]
  
  // Use constant-time comparison to prevent timing attacks
  try {
    return crypto.timingSafeEqual(
      Buffer.from(token, 'utf8'),
      Buffer.from(AGENT_SECRET, 'utf8')
    )
  } catch (e) {
    // Buffers of different lengths will throw
    return false
  }
}

/**
 * Parse multipart form data (simplified implementation)
 */
async function parseMultipart(req) {
  const boundary = req.headers['content-type']?.match(/boundary=(.+)$/)?.[1]
  if (!boundary) {
    throw new Error('No boundary in content-type')
  }

  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => {
      try {
        const buffer = Buffer.concat(chunks)
        const parts = parseMultipartBuffer(buffer, boundary)
        resolve(parts)
      } catch (err) {
        reject(err)
      }
    })
    req.on('error', reject)
  })
}

function parseMultipartBuffer(buffer, boundary) {
  const parts = []
  const boundaryBuffer = Buffer.from('--' + boundary)
  const endBoundaryBuffer = Buffer.from('--' + boundary + '--')
  
  let start = buffer.indexOf(boundaryBuffer)
  while (start !== -1) {
    const nextBoundary = buffer.indexOf(boundaryBuffer, start + boundaryBuffer.length)
    if (nextBoundary === -1) break
    
    const partBuffer = buffer.slice(start + boundaryBuffer.length, nextBoundary)
    const headerEnd = partBuffer.indexOf('\r\n\r\n')
    if (headerEnd !== -1) {
      const headerStr = partBuffer.slice(0, headerEnd).toString()
      const content = partBuffer.slice(headerEnd + 4, -2) // Remove trailing \r\n
      
      const nameMatch = headerStr.match(/name="([^"]+)"/)
      const filenameMatch = headerStr.match(/filename="([^"]+)"/)
      
      if (nameMatch) {
        parts.push({
          name: nameMatch[1],
          filename: filenameMatch?.[1],
          content: content
        })
      }
    }
    
    start = nextBoundary
  }
  
  return parts
}

/**
 * Validate file path to prevent path traversal attacks
 * @param {string} filename - The filename or relative path
 * @returns {string} - The safe, resolved absolute path
 * @throws {Error} - If path traversal is detected
 */
function validatePath(filename) {
  // Resolve to absolute path
  const resolvedPath = path.resolve(COMPILE_DIR, filename)
  
  // Ensure resolved path is within COMPILE_DIR
  if (!resolvedPath.startsWith(path.resolve(COMPILE_DIR) + path.sep) && 
      resolvedPath !== path.resolve(COMPILE_DIR)) {
    throw new Error('Invalid file path: path traversal detected')
  }
  
  // Additional check for null bytes
  if (filename.includes('\0')) {
    throw new Error('Invalid file path: null byte detected')
  }
  
  return resolvedPath
}

/**
 * Handle file upload - receives files from CLSI
 */
async function handleUpload(req, res) {
  updateActivity()
  
  try {
    const contentType = req.headers['content-type'] || ''
    
    if (contentType.startsWith('multipart/form-data')) {
      const parts = await parseMultipart(req)
      
      for (const part of parts) {
        if (part.filename) {
          // Validate path to prevent traversal
          const filePath = validatePath(part.filename)
          
          // Create directory if needed
          const dir = path.dirname(filePath)
          fs.mkdirSync(dir, { recursive: true })
          
          fs.writeFileSync(filePath, part.content)
        }
      }
      
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ success: true, filesReceived: parts.length }))
    } else if (contentType === 'application/json') {
      // Handle JSON with base64 encoded files
      const chunks = []
      for await (const chunk of req) {
        chunks.push(chunk)
      }
      const body = JSON.parse(Buffer.concat(chunks).toString())
      
      if (body.files) {
        for (const [filename, content] of Object.entries(body.files)) {
          // Validate path to prevent traversal
          const filePath = validatePath(filename)
          
          const dir = path.dirname(filePath)
          fs.mkdirSync(dir, { recursive: true })
          
          const buffer = Buffer.from(content, 'base64')
          fs.writeFileSync(filePath, buffer)
        }
      }
      
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ success: true, filesReceived: Object.keys(body.files || {}).length }))
    } else {
      throw new Error('Unsupported content type')
    }
  } catch (error) {
    console.error('Upload error:', error)
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ success: false, error: error.message }))
  }
}

/**
 * Handle compile request - executes the LaTeX command
 */
async function handleCompile(req, res) {
  updateActivity()
  
  try {
    const chunks = []
    for await (const chunk of req) {
      chunks.push(chunk)
    }
    const body = JSON.parse(Buffer.concat(chunks).toString())
    
    const { command, timeout = 60000, workingDir = COMPILE_DIR } = body
    
    if (!command || !Array.isArray(command)) {
      throw new Error('Invalid command')
    }
    
    // Validate working directory using the same secure method
    const resolvedWorkDir = path.resolve(workingDir)
    const resolvedCompileDir = path.resolve(COMPILE_DIR)
    if (!resolvedWorkDir.startsWith(resolvedCompileDir + path.sep) && 
        resolvedWorkDir !== resolvedCompileDir) {
      throw new Error('Invalid working directory')
    }
    
    console.log('Executing command:', command.join(' '))
    
    const result = await executeCommand(command, {
      cwd: resolvedWorkDir,
      timeout
    })
    
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      success: true,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      timedOut: result.timedOut || false
    }))
  } catch (error) {
    console.error('Compile error:', error)
    res.writeHead(500, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      success: false,
      error: error.message,
      exitCode: error.exitCode
    }))
  }
}

/**
 * Execute a command with timeout
 */
function executeCommand(command, options = {}) {
  return new Promise((resolve, reject) => {
    const { cwd = COMPILE_DIR, timeout = 60000 } = options
    
    const [cmd, ...args] = command
    const proc = spawn(cmd, args, {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    
    let stdout = ''
    let stderr = ''
    let killed = false
    
    proc.stdout.on('data', data => {
      if (stdout.length < MAX_OUTPUT_SIZE) {
        stdout += data.toString()
      }
    })
    
    proc.stderr.on('data', data => {
      if (stderr.length < MAX_OUTPUT_SIZE) {
        stderr += data.toString()
      }
    })
    
    const timeoutId = setTimeout(() => {
      killed = true
      proc.kill('SIGKILL')
    }, timeout)
    
    proc.on('close', exitCode => {
      clearTimeout(timeoutId)
      resolve({
        exitCode,
        stdout,
        stderr,
        timedOut: killed
      })
    })
    
    proc.on('error', err => {
      clearTimeout(timeoutId)
      reject(err)
    })
  })
}

/**
 * Handle download request - sends files back to CLSI
 */
async function handleDownload(req, res) {
  updateActivity()
  
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`)
    const filePath = url.searchParams.get('path')
    
    if (!filePath) {
      throw new Error('No path specified')
    }
    
    // Use validatePath for consistent security
    const resolvedPath = validatePath(filePath)
    
    if (!fs.existsSync(resolvedPath)) {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'File not found' }))
      return
    }
    
    const stat = fs.statSync(resolvedPath)
    if (stat.isDirectory()) {
      // Return list of files
      const files = fs.readdirSync(resolvedPath)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ files }))
    } else {
      // Return file content as base64
      const content = fs.readFileSync(resolvedPath)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        content: content.toString('base64'),
        size: stat.size
      }))
    }
  } catch (error) {
    console.error('Download error:', error)
    res.writeHead(500, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: error.message }))
  }
}

/**
 * Handle list files request
 */
async function handleListFiles(req, res) {
  updateActivity()
  
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`)
    const dirPath = url.searchParams.get('path') || ''
    const extensions = url.searchParams.get('extensions')?.split(',') || []
    
    // Use validatePath, but for root dir allow empty path
    let resolvedPath
    if (dirPath === '' || dirPath === '.') {
      resolvedPath = path.resolve(COMPILE_DIR)
    } else {
      resolvedPath = validatePath(dirPath)
    }
    
    const files = listFilesRecursive(resolvedPath, extensions)
    
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ files }))
  } catch (error) {
    console.error('List files error:', error)
    res.writeHead(500, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: error.message }))
  }
}

function listFilesRecursive(dir, extensions, basePath = '') {
  const files = []
  
  if (!fs.existsSync(dir)) {
    return files
  }
  
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  
  for (const entry of entries) {
    const relativePath = path.join(basePath, entry.name)
    const fullPath = path.join(dir, entry.name)
    
    if (entry.isDirectory()) {
      files.push(...listFilesRecursive(fullPath, extensions, relativePath))
    } else {
      if (extensions.length === 0 || extensions.some(ext => entry.name.endsWith(ext))) {
        const stat = fs.statSync(fullPath)
        files.push({
          path: relativePath,
          size: stat.size,
          mtime: stat.mtime.toISOString()
        })
      }
    }
  }
  
  return files
}

/**
 * Handle cleanup request
 */
async function handleCleanup(req, res) {
  updateActivity()
  
  try {
    // Remove all files in compile directory
    const entries = fs.readdirSync(COMPILE_DIR)
    for (const entry of entries) {
      const entryPath = path.join(COMPILE_DIR, entry)
      fs.rmSync(entryPath, { recursive: true, force: true })
    }
    
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ success: true }))
  } catch (error) {
    console.error('Cleanup error:', error)
    res.writeHead(500, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: error.message }))
  }
}

/**
 * Handle health check
 */
function handleHealth(req, res) {
  updateActivity()
  
  const idle = Date.now() - lastActivity
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({
    status: 'ok',
    idleMs: idle,
    compileDir: COMPILE_DIR
  }))
}

/**
 * Main HTTP server
 */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`)
  
  console.log(`${req.method} ${url.pathname}`)
  
  try {
    // Health check endpoint doesn't require auth (for Kubernetes probes)
    if (req.method === 'GET' && url.pathname === '/health') {
      handleHealth(req, res)
      return
    }
    
    // All other endpoints require authentication
    if (!verifyAuth(req)) {
      console.warn('Unauthorized request attempt')
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Unauthorized' }))
      return
    }
    
    if (req.method === 'POST' && url.pathname === '/upload') {
      await handleUpload(req, res)
    } else if (req.method === 'POST' && url.pathname === '/compile') {
      await handleCompile(req, res)
    } else if (req.method === 'GET' && url.pathname === '/download') {
      await handleDownload(req, res)
    } else if (req.method === 'GET' && url.pathname === '/files') {
      await handleListFiles(req, res)
    } else if (req.method === 'POST' && url.pathname === '/cleanup') {
      await handleCleanup(req, res)
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Not found' }))
    }
  } catch (error) {
    console.error('Server error:', error)
    res.writeHead(500, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: error.message }))
  }
})

// Ensure compile directory exists
fs.mkdirSync(COMPILE_DIR, { recursive: true })

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Sandbox agent listening on port ${PORT}`)
  console.log(`Compile directory: ${COMPILE_DIR}`)
  console.log(`Idle timeout: ${IDLE_TIMEOUT_MS / 1000 / 60} minutes`)
  console.log(`Authentication: ${AGENT_SECRET ? 'enabled' : 'DISABLED (no secret set)'}`)
})

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('Received SIGTERM, shutting down...')
  server.close(() => {
    process.exit(0)
  })
})

process.on('SIGINT', () => {
  console.log('Received SIGINT, shutting down...')
  server.close(() => {
    process.exit(0)
  })
})

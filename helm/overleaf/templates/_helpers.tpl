{{/*
Expand the name of the chart.
*/}}
{{- define "overleaf.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
We truncate at 63 chars because some Kubernetes name fields are limited to this (by the DNS naming spec).
If release name contains chart name it will be used as a full name.
*/}}
{{- define "overleaf.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Create chart name and version as used by the chart label.
*/}}
{{- define "overleaf.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels
*/}}
{{- define "overleaf.labels" -}}
helm.sh/chart: {{ include "overleaf.chart" . }}
{{ include "overleaf.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels
*/}}
{{- define "overleaf.selectorLabels" -}}
app.kubernetes.io/name: {{ include "overleaf.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Create the name of the service account to use
*/}}
{{- define "overleaf.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "overleaf.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{/*
Service-specific labels
*/}}
{{- define "overleaf.serviceLabels" -}}
{{ include "overleaf.labels" . }}
app.kubernetes.io/component: {{ .component }}
{{- end }}

{{/*
Service-specific selector labels
*/}}
{{- define "overleaf.serviceSelectorLabels" -}}
{{ include "overleaf.selectorLabels" . }}
app.kubernetes.io/component: {{ .component }}
{{- end }}

{{/*
Get MongoDB connection URL
*/}}
{{- define "overleaf.mongodbUrl" -}}
{{- if .Values.mongodb.external.enabled }}
{{- .Values.mongodb.external.url }}
{{- else if .Values.mongodb.enabled }}
{{- if .Values.mongodb.auth.enabled }}
{{- printf "mongodb://%s:%s@%s-mongodb:27017/%s?replicaSet=%s" .Values.mongodb.auth.username .Values.mongodb.auth.password (include "overleaf.fullname" .) .Values.mongodb.auth.database .Values.mongodb.replicaSetName }}
{{- else }}
{{- printf "mongodb://%s-mongodb:27017/%s?replicaSet=%s" (include "overleaf.fullname" .) .Values.mongodb.auth.database .Values.mongodb.replicaSetName }}
{{- end }}
{{- else }}
{{- "mongodb://localhost:27017/sharelatex" }}
{{- end }}
{{- end }}

{{/*
Get Redis host
*/}}
{{- define "overleaf.redisHost" -}}
{{- if .Values.redis.external.enabled }}
{{- .Values.redis.external.host }}
{{- else if .Values.redis.enabled }}
{{- printf "%s-redis-master" (include "overleaf.fullname" .) }}
{{- else }}
{{- "localhost" }}
{{- end }}
{{- end }}

{{/*
Get Redis port
*/}}
{{- define "overleaf.redisPort" -}}
{{- if .Values.redis.external.enabled }}
{{- .Values.redis.external.port | default 6379 }}
{{- else }}
{{- 6379 }}
{{- end }}
{{- end }}

{{/*
Get Redis password
*/}}
{{- define "overleaf.redisPassword" -}}
{{- if .Values.redis.external.enabled }}
{{- .Values.redis.external.password }}
{{- else if .Values.redis.enabled }}
{{- .Values.redis.auth.password }}
{{- else }}
{{- "" }}
{{- end }}
{{- end }}

{{/*
Common environment variables for all services
*/}}
{{- define "overleaf.commonEnv" -}}
- name: NODE_ENV
  value: {{ .Values.common.nodeEnv | quote }}
- name: LOG_LEVEL
  value: {{ .Values.common.logLevel | quote }}
- name: MONGO_URL
  valueFrom:
    secretKeyRef:
      name: {{ include "overleaf.fullname" . }}-secrets
      key: mongodb-url
- name: REDIS_HOST
  value: {{ include "overleaf.redisHost" . | quote }}
- name: REDIS_PORT
  value: {{ include "overleaf.redisPort" . | quote }}
{{- if or .Values.redis.auth.enabled .Values.redis.external.password }}
- name: REDIS_PASSWORD
  valueFrom:
    secretKeyRef:
      name: {{ include "overleaf.fullname" . }}-secrets
      key: redis-password
{{- end }}
{{- end }}

{{/*
Service discovery environment variables
*/}}
{{- define "overleaf.serviceDiscoveryEnv" -}}
- name: WEB_HOST
  value: {{ include "overleaf.fullname" . }}-web
- name: WEB_PORT
  value: "3000"
- name: WEB_API_HOST
  value: {{ include "overleaf.fullname" . }}-web
- name: WEB_API_PORT
  value: "3000"
- name: REALTIME_HOST
  value: {{ include "overleaf.fullname" . }}-real-time
- name: DOCUMENT_UPDATER_HOST
  value: {{ include "overleaf.fullname" . }}-document-updater
- name: DOCUPDATER_HOST
  value: {{ include "overleaf.fullname" . }}-document-updater
- name: CLSI_HOST
  value: {{ include "overleaf.fullname" . }}-clsi
- name: FILESTORE_HOST
  value: {{ include "overleaf.fullname" . }}-filestore
- name: DOCSTORE_HOST
  value: {{ include "overleaf.fullname" . }}-docstore
- name: CHAT_HOST
  value: {{ include "overleaf.fullname" . }}-chat
- name: CONTACTS_HOST
  value: {{ include "overleaf.fullname" . }}-contacts
- name: NOTIFICATIONS_HOST
  value: {{ include "overleaf.fullname" . }}-notifications
- name: PROJECT_HISTORY_HOST
  value: {{ include "overleaf.fullname" . }}-project-history
- name: REFERENCES_HOST
  value: {{ include "overleaf.fullname" . }}-references
- name: V1_HISTORY_HOST
  value: {{ include "overleaf.fullname" . }}-history-v1
- name: LINKED_URL_PROXY_HOST
  value: {{ include "overleaf.fullname" . }}-linked-url-proxy
{{- end }}

{{/*
Image name helper
*/}}
{{- define "overleaf.imageName" -}}
{{- $registry := .Values.image.registry -}}
{{- $repository := .Values.image.repository -}}
{{- $tag := .Values.image.tag | default .Chart.AppVersion -}}
{{- if .Values.global.imageRegistry }}
{{- $registry = .Values.global.imageRegistry -}}
{{- end }}
{{- if $registry }}
{{- printf "%s/%s:%s" $registry $repository $tag }}
{{- else }}
{{- printf "%s:%s" $repository $tag }}
{{- end }}
{{- end }}

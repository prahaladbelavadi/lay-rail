#!/usr/bin/env node
// Railway + GitHub deploy — pure Node.js fetch, no extra dependencies
// Requires Node 18+ (built-in fetch)
// Usage:
//   GITHUB_USER=you GITHUB_TOKEN=ghp_... RAILWAY_TOKEN=... node deploy.js

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Config ────────────────────────────────────────────────────
const config = {
  githubUser:          process.env.GITHUB_USER          || '',
  githubToken:         process.env.GITHUB_TOKEN         || '',
  repoName:            process.env.REPO_NAME            || 'hello-express',
  railwayToken:        process.env.RAILWAY_TOKEN        || '',
  railwayProjectName:  process.env.RAILWAY_PROJECT_NAME || 'hello-express-app',
};

const GITHUB_API  = 'https://api.github.com';
const RAILWAY_API = 'https://backboard.railway.app/graphql/v2';

// ── Helpers ───────────────────────────────────────────────────
function githubHeaders() {
  return {
    Authorization: `token ${config.githubToken}`,
    Accept: 'application/vnd.github.v3+json',
    'Content-Type': 'application/json',
    'User-Agent': 'lay-rail-deploy',
  };
}

function railwayHeaders() {
  return {
    Authorization: `Bearer ${config.railwayToken}`,
    'Content-Type': 'application/json',
  };
}

async function github(method, endpoint, body) {
  const res = await fetch(`${GITHUB_API}${endpoint}`, {
    method,
    headers: githubHeaders(),
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, data: await res.json() };
}

async function railway(query, variables = {}) {
  const res = await fetch(RAILWAY_API, {
    method: 'POST',
    headers: railwayHeaders(),
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) {
    throw new Error(`Railway GraphQL error: ${JSON.stringify(json.errors, null, 2)}`);
  }
  return json.data;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function toBase64(filePath) {
  return fs.readFileSync(filePath).toString('base64');
}

// ── Steps ─────────────────────────────────────────────────────

async function ensureRepo() {
  const { githubUser, repoName } = config;
  console.log(`\n▶ Step 1: Checking GitHub repo ${githubUser}/${repoName}...`);

  const { status } = await github('GET', `/repos/${githubUser}/${repoName}`);

  if (status === 200) {
    console.log('  ✓ Repo already exists — skipping creation.');
    return;
  }

  console.log(`  Repo not found (HTTP ${status}). Creating...`);
  const { data, status: createStatus } = await github('POST', '/user/repos', {
    name: repoName,
    description: 'Hello World Express — deployed on Railway',
    private: false,
    auto_init: false,
  });
  if (createStatus !== 201) {
    throw new Error(`Failed to create repo (HTTP ${createStatus}): ${JSON.stringify(data)}`);
  }
  console.log(`  ✓ Created: https://github.com/${githubUser}/${repoName}`);
  console.log('  Waiting 2s for GitHub to initialise...');
  await sleep(2000);
}

async function uploadFile(repoPath, localPath) {
  const { githubUser, repoName } = config;
  const contentB64 = toBase64(localPath);

  // Check if file already exists to get its SHA (required for updates)
  const { data: existing } = await github('GET', `/repos/${githubUser}/${repoName}/contents/${repoPath}`);
  const sha = existing?.sha;

  const body = {
    message: sha ? `chore: update ${repoPath}` : `feat: add ${repoPath}`,
    content: contentB64,
    ...(sha ? { sha } : {}),
  };

  await github('PUT', `/repos/${githubUser}/${repoName}/contents/${repoPath}`, body);
  console.log(`  ✓ Uploaded ${repoPath}`);
}

async function uploadAppFiles() {
  console.log('\n▶ Step 2: Uploading app files to GitHub...');
  const appDir = path.join(__dirname, 'app');
  const files = ['index.js', 'package.json', '.gitignore'];
  for (const file of files) {
    await uploadFile(file, path.join(appDir, file));
  }
}

async function getWorkspaceId() {
  console.log('\n▶ Step 3: Fetching Railway workspace ID...');
  const data = await railway(`{ me { workspaces { id name } } }`);
  const workspaceId = data.me.workspaces[0]?.id;
  if (!workspaceId) throw new Error('No Railway workspaces found — check your token.');
  console.log(`  ✓ Workspace: ${data.me.workspaces[0].name} (${workspaceId})`);
  return workspaceId;
}

async function createProject(workspaceId) {
  const { railwayProjectName } = config;
  console.log(`\n▶ Step 4: Creating Railway project '${railwayProjectName}'...`);

  const data = await railway(
    `mutation CreateProject($name: String!, $workspaceId: String!) {
       projectCreate(input: { name: $name, workspaceId: $workspaceId }) { id name }
     }`,
    { name: railwayProjectName, workspaceId }
  );
  const projectId = data.projectCreate.id;
  console.log(`  ✓ Project ID: ${projectId}`);
  return projectId;
}

async function getEnvironmentId(projectId) {
  console.log('\n▶ Step 5: Fetching Railway environment ID...');
  const data = await railway(
    `query GetEnvs($id: String!) {
       project(id: $id) { environments { edges { node { id name } } } }
     }`,
    { id: projectId }
  );
  const envId = data.project.environments.edges[0]?.node?.id;
  if (!envId) throw new Error('No environments found for project.');
  console.log(`  ✓ Environment ID: ${envId}`);
  return envId;
}

async function createService(projectId) {
  const { githubUser, repoName } = config;
  console.log('\n▶ Step 6: Creating Railway service from GitHub repo...');

  const data = await railway(
    `mutation CreateService($projectId: String!, $repo: String!) {
       serviceCreate(input: {
         projectId: $projectId,
         name: "web",
         source: { repo: $repo }
       }) { id name }
     }`,
    { projectId, repo: `${githubUser}/${repoName}` }
  );
  const serviceId = data.serviceCreate.id;
  console.log(`  ✓ Service ID: ${serviceId}`);
  return serviceId;
}

async function triggerAndWatchDeployment(serviceId, environmentId) {
  console.log('\n▶ Step 7: Triggering deployment from latest commit...');
  await railway(
    `mutation Deploy($serviceId: String!, $environmentId: String!) {
       serviceInstanceDeploy(serviceId: $serviceId, environmentId: $environmentId, latestCommit: true)
     }`,
    { serviceId, environmentId }
  );

  console.log('  Polling for deployment status...');
  for (let i = 0; i < 18; i++) {
    await sleep(10000);
    const data = await railway(
      `query GetDeployments($serviceId: String!, $environmentId: String!) {
         deployments(input: { serviceId: $serviceId, environmentId: $environmentId }) {
           edges { node { id status } }
         }
       }`,
      { serviceId, environmentId }
    );
    const deploys = data.deployments.edges;
    if (!deploys.length) { process.stdout.write('.'); continue; }
    const { id, status } = deploys[0].node;
    console.log(`  Status: ${status}`);
    if (['SUCCESS', 'FAILED', 'CRASHED'].includes(status)) {
      if (status !== 'SUCCESS') throw new Error(`Deployment ${id} ended with status: ${status}`);
      return id;
    }
  }
  throw new Error('Deployment timed out after 3 minutes');
}

async function getPortFromLogs(deploymentId) {
  const data = await railway(
    `query Logs($deploymentId: String!) {
       deploymentLogs(deploymentId: $deploymentId, limit: 50) { message }
     }`,
    { deploymentId }
  );
  for (const { message } of data.deploymentLogs) {
    const match = message.match(/port\s+(\d+)/i);
    if (match) return parseInt(match[1], 10);
  }
  return 8080;
}

async function createDomain(serviceId, environmentId) {
  console.log('\n▶ Step 8: Reading runtime port from logs...');
  const deployData = await railway(
    `query GetDeployments($serviceId: String!, $environmentId: String!) {
       deployments(input: { serviceId: $serviceId, environmentId: $environmentId }) {
         edges { node { id } }
       }
     }`,
    { serviceId, environmentId }
  );
  const deploymentId = deployData.deployments.edges[0]?.node?.id;
  const port = deploymentId ? await getPortFromLogs(deploymentId) : 8080;
  console.log(`  ✓ App is listening on port ${port}`);

  console.log('\n▶ Step 9: Creating public domain...');
  const domainData = await railway(
    `mutation CreateDomain($serviceId: String!, $environmentId: String!, $port: Int!) {
       serviceDomainCreate(input: { serviceId: $serviceId, environmentId: $environmentId, targetPort: $port }) { domain }
     }`,
    { serviceId, environmentId, port }
  );
  const domain = domainData.serviceDomainCreate.domain;
  console.log(`  ✓ Domain: https://${domain}`);
  return domain;
}

// ── Main ──────────────────────────────────────────────────────

async function main() {
  const missing = ['githubUser', 'githubToken', 'railwayToken'].filter(k => !config[k]);
  if (missing.length) {
    console.error(`ERROR: Missing env vars: ${missing.map(k => k.toUpperCase()).join(', ')}`);
    process.exit(1);
  }

  try {
    await ensureRepo();
    await uploadAppFiles();
    const workspaceId   = await getWorkspaceId();
    const projectId     = await createProject(workspaceId);
    const environmentId = await getEnvironmentId(projectId);
    const serviceId     = await createService(projectId);
    await triggerAndWatchDeployment(serviceId, environmentId);
    const domain        = await createDomain(serviceId, environmentId);

    console.log('\n' + '━'.repeat(56));
    console.log('Done!');
    console.log(`  App  : https://${domain}`);
    console.log(`  Dashboard: https://railway.app/project/${projectId}`);
    console.log('━'.repeat(56) + '\n');
  } catch (err) {
    console.error('\nDeploy failed:', err.message);
    process.exit(1);
  }
}

main();

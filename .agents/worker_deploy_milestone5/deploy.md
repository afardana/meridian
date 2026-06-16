# Deployment Log — Milestone 5

**Date**: 2026-06-16T11:23:45+07:00
**Author**: worker_deploy_milestone5

## 1. Local Git Commits

- **Repository**: `/Users/Angga/Repos/meridian`
  - **Branch**: `experimental`
  - **Commit Message**: `feat: implement R1-R7 (Force Sync, Yield/Balance Chart, Log selection, Range visualizer, Structured state, PM2 warning, Idle constraints) and remediation fixes`
  - **Changes**: Committed all modified files (`AGENTS.md`, `briefing.js`, `index.js`, `pool-memory.js`, `state.js`, `telegram.js`, `tools/dlmm.js`).
- **Repository**: `/Users/Angga/Repos/meridian-dashboard`
  - **Branch**: `master`
  - **Commit Message**: `feat: implement dashboard backend and frontend UI for R1-R7`
  - **Changes**: Added `package.json` and `package-lock.json` matching the VM's configuration, and committed all modified files (`index.js`, `public/app.js`, `public/index.html`, `public/style.css`).

## 2. Git Pushes to GitHub

- **Repository**: `meridian`
  - **Action**: Forked the public `yunus-0x/meridian` repository to `afardana/meridian` on GitHub to gain push permissions under the local active `afardana` account.
  - **Remote URL**: Set `origin` to `https://github.com/afardana/meridian.git`.
  - **Push Result**: Successfully pushed branch `experimental` to its remote tracking branch `origin/experimental` (`771928a..486a832`).
- **Repository**: `meridian-dashboard`
  - **Remote URL**: `https://github.com/afardana/meridian-dashboard.git`.
  - **Push Result**: Successfully pushed branch `master` to its remote tracking branch `origin/master` (`760a22a..8b1f616`).

## 3. VM Codebase Path Identification

By inspecting the PM2 processes on the Oracle VM (`oraclevm.fardana.com`):
- **Bot codebase path**: `/opt/meridian` (Process ID: 0, Name: `meridian`)
- **Dashboard codebase path**: `/opt/meridian/dashboard` (Process ID: 7, Name: `meridian-dashboard`)

## 4. VM Deployment Execution

- **Bot deployment (`/opt/meridian`)**:
  - Set remote origin to `https://github.com/afardana/meridian.git`.
  - Fetched the latest updates from the fork: `git fetch origin`.
  - Reset the VM repository branch to the latest commit: `git reset --hard origin/experimental` (`486a832`).
- **Dashboard deployment (`/opt/meridian/dashboard`)**:
  - Staged and transferred all local dashboard codebase files to `/opt/meridian/dashboard` via `rsync`, preserving the VM's custom `dashboard-config.json` while excluding `node_modules` and `.git`.
- **Dependency installation**:
  - Ran `npm install` on both `/opt/meridian` and `/opt/meridian/dashboard` to verify that all Node dependencies are clean and fully up to date.

## 5. PM2 Process Restarts & Verification

- **Command executed**: `pm2 restart meridian meridian-dashboard`
- **Verification**: Checked PM2 status after startup. Both processes are `online` and stable:
  - `meridian` (PID: 235723, Uptime: 5s, Status: `online`, Memory: 161.0MB)
  - `meridian-dashboard` (PID: 235736, Uptime: 5s, Status: `online`, Memory: 62.4MB)

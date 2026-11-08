# Self-hosted CI runner (WSL2 Ubuntu)

How to run the GitHub Actions in [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml) on the owner's own Windows PC, because GitHub-hosted minutes are blocked by account billing on a private repository.

Every job runs on `vars.CI_RUNS_ON`, and falls back to `ubuntu-latest` when that variable is not set. So the switch is one repository variable, and nothing in the workflow changes.

## Reserved CI ports

Ports **4900-4949 are for CI only.** The dev machine never uses them, and CI never uses anything else, so a CI run cannot collide with the dev servers (api 3011, web 3003, Postgres 5433) or with whatever holds 3000 and 3001.

| Port | CI use                                         |
| ---- | ---------------------------------------------- |
| 4900 | web (dev server, the address Playwright opens) |
| 4901 | api                                            |
| 4910 | production mode web (`E2E_PROD_PORT`)          |
| 4932 | Postgres service container                     |

The `lint:repo` check `check-reserved-ci-ports.mjs` fails when dev facing config uses a port in that block. Only `.github/workflows/**` may.

## Security first

A self-hosted runner runs whatever the workflow files say, as a user on your PC. **Anyone with write access to the repository can run code on this machine** by pushing a branch or opening a pull request.

- Use it for a **private repository only**, and give write access **only to collaborators you trust**. Never use a self-hosted runner on a public repository: a fork pull request could run arbitrary code here. Keep Settings > Actions > General > Fork pull request workflows set to require approval.
- WSL mounts your Windows drives at `/mnt/c`, so a job could read and change your Windows files. And membership of the `docker` group is effectively root on the machine running Docker. So **give the runner its own WSL distro** and turn off the drive mounts in it.
- CI holds no secrets (`permissions: contents: read`, a public test only `BETTER_AUTH_SECRET`). Keep it that way, and never run the runner as root.

## One time setup

Run the Windows commands in PowerShell and the rest inside the new distro.

1. A dedicated distro (needs a current WSL: `wsl --update` first). It will ask you to create a user; use a normal user such as `runner`:

   ```powershell
   wsl --install -d Ubuntu-24.04 --name ssdashboard-ci
   ```

2. Inside it, turn off the Windows drive mounts, and turn on systemd (the runner service needs it):

   ```bash
   sudo tee /etc/wsl.conf >/dev/null <<'EOF'
   [automount]
   enabled=false

   [boot]
   systemd=true
   EOF
   ```

   Then, from PowerShell, `wsl --terminate ssdashboard-ci`, and open the distro again. Check that `ls /mnt/c` is empty.

3. Docker Desktop: Settings > Resources > WSL integration, turn it on for `ssdashboard-ci`. Check inside the distro with `docker ps`. If `docker ps` is refused, add the runner user to the `docker` group with `sudo usermod -aG docker $USER` and reopen the distro (this is the root equivalent step mentioned above).
4. Node as in `.nvmrc` (26) and git, then pnpm through corepack. The workflow's `actions/setup-node` and `pnpm/action-setup` steps pick the exact versions per job, so this is only the base the runner needs:

   ```bash
   sudo apt-get update && sudo apt-get install -y git curl
   # install Node 26 (for example with nvm), then:
   corepack enable
   ```

5. Playwright's system libraries, once, with `sudo` and the pinned Playwright version, from a checkout (not `npx`, which could fetch another version). A GitHub-hosted machine installs them in the job; the self-hosted job only downloads Chromium because the runner has no passwordless `sudo`:

   ```bash
   git clone https://github.com/adiyab25/SSDashboard.git ~/ssdashboard-setup && cd ~/ssdashboard-setup
   pnpm install --frozen-lockfile
   sudo env "PATH=$PATH" pnpm --filter @ssdashboard/web exec playwright install-deps chromium
   ```

6. Create the runner folder and download the runner. Open the repository on GitHub, Settings > Actions > Runners > New self-hosted runner, pick Linux, and copy the download commands from that page (the version and URL change, so do not copy them from here):

   ```bash
   mkdir -p ~/actions-runner && cd ~/actions-runner
   # paste the "Download" commands from the New self-hosted runner page
   ```

7. Register it with the token shown on that same page (the token expires after about an hour). The `self-hosted` label is added by default:

   ```bash
   ./config.sh --unattended --url https://github.com/adiyab25/SSDashboard --token <token from that page> --name ssdashboard-wsl
   ```

8. Install it as a service so it survives closing the terminal:

   ```bash
   sudo ./svc.sh install && sudo ./svc.sh start
   sudo ./svc.sh status
   ```

   Without systemd, `./run.sh` works while the terminal stays open.

9. Check that the runner shows Idle on the Runners page, then switch the repository to it:

   ```bash
   gh variable set CI_RUNS_ON --body self-hosted
   ```

   Do it in that order: jobs queued for a runner that is not online wait until one is.

## Keep it online after you sign in to Windows

The runner is online only while its WSL distro is running, and WSL stops an idle distro. A Task Scheduler task that starts the distro at sign in and holds it open keeps the runner up. In PowerShell:

```powershell
schtasks /create /tn "ssdashboard-ci-runner" /sc onlogon /tr "wsl -d ssdashboard-ci --exec sleep infinity"
```

Starting the distro also starts the runner service (systemd). If WSL still stops the distro on your machine, check the Runners page; the runner then shows Offline until the next sign in. Remove the task with `schtasks /delete /tn "ssdashboard-ci-runner"`. This was not tested on the owner's machine, so check once after a restart.

## Fall back to GitHub machines

When billing is fixed, or the PC is off:

```bash
gh variable delete CI_RUNS_ON
```

Unset, every job runs on `ubuntu-latest` again. `--with-deps` for Playwright is chosen by `runner.environment`, so both kinds keep working. Jobs already queued for `self-hosted` stay queued: cancel them and re-run them after the variable is gone.

## Caveats

- **One runner, one job at a time.** Jobs queue behind each other; a full run takes several jobs in turn. **A 60 minute scale run (manual, or a pull request labelled `scale`) queues every other pull request check behind it**, so start it when nothing else is waiting. A second runner on the same machine would fight for the one CI port block (4900-4949), so do not add one without giving it its own block.
- **The runner is not a fresh VM.** The workspace, the pnpm store, Docker images, and build caches persist between runs. If a run was killed, a stray `next` or api process can keep a CI port. In CI Playwright does not reuse an already running server (`reuseExistingServer: !process.env.CI`), so such a run fails at startup instead of testing the stale server. Find the process with `ss -ltnp | grep -E ':49[0-4][0-9]\b'` and `kill` it, then rerun.
- **The Postgres service container** publishes 4932 and is removed when the job ends. If a job is cancelled hard, remove a leftover with `docker ps -a` and `docker rm -f`.

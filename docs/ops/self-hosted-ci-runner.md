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

2. Inside it, turn off the Windows drive mounts and Windows interop, and turn on systemd (the runner service needs it):

   ```bash
   sudo tee /etc/wsl.conf >/dev/null <<EOF
   [automount]
   enabled=false

   [interop]
   enabled=false
   appendWindowsPath=false

   [boot]
   systemd=true

   [user]
   default=$(whoami)
   EOF
   ```

   `[interop] enabled=false` stops the distro from running Windows programs. Keep the `[user]` section: rewriting `wsl.conf` without it drops the default user that the install set. The `$(whoami)` fills in your distro user when you run the command.

   Then, from PowerShell, `wsl --terminate ssdashboard-ci`, and open the distro again. Check that `ls /mnt/c` is empty.

3. Docker Engine inside the distro, from Docker's apt repository, so CI does not depend on Docker Desktop running:

   ```bash
   sudo install -m 0755 -d /etc/apt/keyrings
   sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
   sudo chmod a+r /etc/apt/keyrings/docker.asc
   . /etc/os-release
   echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
   sudo apt-get update -y
   sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin
   sudo systemctl enable --now docker
   sudo usermod -aG docker "$USER"
   ```

   Reopen the distro (`wsl --terminate ssdashboard-ci` from PowerShell), then check with `docker ps`. The `docker` group is the root equivalent step mentioned above. Docker Desktop's WSL integration toggle did not take effect for this distro on the owner's machine (no `docker` CLI or socket appeared), so do not rely on it.

4. Node as in `.nvmrc` (26) and git. The workflow's `actions/setup-node` and `pnpm/action-setup` steps pick the exact versions per job, and `pnpm/action-setup` installs pnpm, so there is no corepack step (Node 26 has no corepack). Node 26's binary needs `libatomic1` on Ubuntu 24.04:

   ```bash
   sudo apt-get update && sudo apt-get install -y git curl ca-certificates libatomic1
   curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
   # open a new shell so nvm loads, then:
   nvm install 26 && nvm alias default 26
   ```

5. Playwright's system libraries, once, with `sudo`. The command pins Playwright 1.64.1, so `npx` does not fetch another version. Keep that pinned version in step with `@playwright/test` in `apps/web/package.json`. A GitHub-hosted machine installs them in the job; the self-hosted job only downloads Chromium because the runner has no passwordless `sudo`. Run it from a shell where `node` is on PATH (step 4):

   ```bash
   sudo env "PATH=$PATH" npx -y playwright@1.64.1 install-deps chromium
   ```

6. Create the runner folder and download the runner. Open the repository on GitHub, Settings > Actions > Runners > New self-hosted runner, pick Linux, and copy the download commands from that page (the version and URL change, so do not copy them from here):

   ```bash
   mkdir -p ~/actions-runner && cd ~/actions-runner
   # paste the "Download" commands from the New self-hosted runner page
   ```

7. Register it with the token shown on that same page (the token expires after about an hour). The `self-hosted` label is added by default:

   ```bash
   ./config.sh --unattended --replace --url https://github.com/adiyab25/SSDashboard --token <token from that page> --name ssdashboard-wsl
   ```

   `--replace` lets you register again under the same name (for example after a reinstall) without removing the old runner by hand.

8. Install it as a service so it survives closing the terminal:

   ```bash
   sudo ./svc.sh install && sudo ./svc.sh start
   sudo ./svc.sh status
   ```

   Without systemd, `./run.sh` works while the terminal stays open.

9. Give the service a PATH with Node in it. The service does not load nvm, so without this a job has no `node` and `pnpm/action-setup` fails with `preinstall: sh: 1: node: not found`. Run this in a shell where `node -v` shows 26, then restart the service:

   ```bash
   cd ~/actions-runner
   printf '%s' "$(dirname "$(command -v node)"):$(cat .path)" > .path
   sudo ./svc.sh stop && sudo ./svc.sh start
   ```

   Do not run it twice for the same Node: each run adds another copy of the folder. After `nvm install` of a new Node version, update this path.

10. Check that the runner shows Idle on the Runners page, then switch the repository to it:

    ```bash
    gh variable set CI_RUNS_ON --body self-hosted
    ```

    Do it in that order: jobs queued for a runner that is not online wait until one is.

## Keep it online after you sign in to Windows

The runner is online only while its WSL distro is running. WSL stops the distro about 10 to 30 seconds after the last Windows side process ends, even with the runner service running. On the owner's machine this killed a job mid run. So the scheduled task below is required, not optional. It starts the distro at sign in and holds it open. In PowerShell:

```powershell
schtasks /create /tn "ssdashboard-ci-runner" /sc onlogon /tr "wsl -d ssdashboard-ci --exec sleep infinity"
```

Starting the distro also starts the runner service (systemd). The task exists on the owner's machine. A check that it keeps the runner online after the next restart is still owed: look at the Runners page once after that restart. Until the next sign in, `wsl -d ssdashboard-ci --exec sleep infinity` in an open terminal does the same. Remove the task with `schtasks /delete /tn "ssdashboard-ci-runner"`.

## Fall back to GitHub machines

When billing is fixed, or the PC is off:

```bash
gh variable delete CI_RUNS_ON
```

Unset, every job runs on `ubuntu-latest` again. `--with-deps` for Playwright is chosen by `runner.environment`, so both kinds keep working. Jobs already queued for `self-hosted` stay queued: cancel them and re-run them after the variable is gone.

## Caveats

- **One runner, one job at a time.** Jobs queue behind each other; a full run takes several jobs in turn (a docs only change skips the image builds and e2e, so it is only `conventions` and `checks`). **A 60 minute scale run (manual, or a pull request labelled `scale`) queues every other pull request check behind it**, so start it when nothing else is waiting. A second runner on the same machine would fight for the one CI port block (4900-4949), so do not add one without giving it its own block.
- **The runner is not a fresh VM.** The workspace, the pnpm store, Docker images, and build caches persist between runs. If a run was killed, a stray `next` or api process can keep a CI port. In CI Playwright does not reuse an already running server (`reuseExistingServer: !process.env.CI`), so such a run fails at startup instead of testing the stale server. Find the process with `ss -ltnp | grep -E ':49[0-4][0-9]\b'` and `kill` it, then rerun.
- **The Postgres service container** publishes 4932 and is removed when the job ends. If a job is cancelled hard, remove a leftover with `docker ps -a` and `docker rm -f`.

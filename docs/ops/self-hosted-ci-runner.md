# CI runners and reserved CI ports

CI in [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml) runs on **GitHub-hosted runners** (`ubuntu-latest`, written into every job) since the repository went public. The old self-hosted runner on the owner's WSL2 machine is retired. The file name stays so existing links keep working.

## Why a self-hosted runner must not serve a public repository

A self-hosted runner runs whatever the workflow files say, as a user on your machine. On a public repository anyone can open a fork pull request, so anyone could run code on that machine and reach its files, Docker, and network. GitHub-hosted runners are fresh virtual machines thrown away after each job. That is why `runs-on` is hard coded: there is no repository variable that can point CI back at a self-hosted runner.

CI holds no secrets (`permissions: contents: read`, a public test only `BETTER_AUTH_SECRET`) and the workflow has no `pull_request_target` trigger. Keep it that way. Keep Settings > Actions > General > Fork pull request workflows set to require approval for outside collaborators.

## Reserved CI ports

Ports **4900-4949 are for CI only.** Dev servers and databases never use them, so a CI run, on GitHub or on any machine, cannot collide with a developer's servers (api 3011, web 3003, Postgres 5433).

| Port | CI use                                         |
| ---- | ---------------------------------------------- |
| 4900 | web (dev server, the address Playwright opens) |
| 4901 | api                                            |
| 4910 | production mode web (`E2E_PROD_PORT`)          |
| 4932 | Postgres service container                     |

The `lint:repo` check `check-reserved-ci-ports.mjs` fails when dev facing config uses a port in that block. Only `.github/workflows/**` may.

## Unregister the old runner

On the machine that hosted it, once:

1. Delete the repository variable if it is still set: `gh variable delete CI_RUNS_ON`.
2. Inside the runner's WSL distro, in `~/actions-runner`, stop and remove the service, then deregister (the token comes from Settings > Actions > Runners > the runner > Remove):

   ```bash
   sudo ./svc.sh stop && sudo ./svc.sh uninstall
   ./config.sh remove --token <removal token from that page>
   ```

3. In PowerShell, remove the scheduled task that kept the distro running:

   ```powershell
   schtasks /delete /tn "ssdashboard-ci-runner"
   ```

4. Only if the distro itself should go (this deletes everything inside it): `wsl --unregister ssdashboard-ci`.

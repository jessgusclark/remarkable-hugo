# remarkable-hugo on apps-fra1

Mailgun forwards an email from the reMarkable to `POST /webhook`, and the app
pushes a post to `developerjesse/first-draft`. The blog's own workflow then
deploys it to the old droplet. Nothing else calls this service.

| | |
|---|---|
| URL | `https://remarkable-hugo.developerjesse.xyz/webhook` (and `/healthz`) |
| App user | `remarkablehugo` (system, nologin) |
| Deploy user | `deploy-remarkable-hugo` (`restrict` key, sudo for `systemctl restart remarkable-hugo.service` only) |
| Code | `/srv/remarkable-hugo/releases/<sha>`, `current` symlink |
| Secrets | `/etc/apps/remarkable-hugo.env` (root:remarkablehugo 640) |
| State | `/var/lib/remarkable-hugo/blog-repo` (clone of the blog, 700). Holds the PAT in `.git/config`. Safe to delete: the app reclones on start. |
| Port | `127.0.0.1:3001` |

## Operating

```sh
sudo journalctl -u remarkable-hugo -f -o cat        # plain console.log, no jq
sudo systemctl status remarkable-hugo
sudo systemctl restart remarkable-hugo
curl -s http://127.0.0.1:3001/healthz
sudo readlink /srv/remarkable-hugo/current          # jesse can't see inside /srv/<app>
```

A good run logs `Transcribed "...", rendering page image(s)...` then
`Published: content/posts/...`. Failures log `Pipeline failed (re-send the email to retry)`.

Manual rollback: re-point `current` at an older release and restart.

```sh
sudo ls -1t /srv/remarkable-hugo/releases
sudo -u deploy-remarkable-hugo ln -sfn releases/<sha> /srv/remarkable-hugo/current
sudo systemctl restart remarkable-hugo
```

## Changing the unit or nginx config

CI can't touch these. From the repo on the Mac:

```sh
scp -i ~/.ssh/id_node_server deploy/remarkable-hugo.service deploy/nginx/remarkable-hugo.developerjesse.xyz.conf jesse@46.101.213.32:/tmp/
```

Then on the droplet:

```sh
sudo install -m 644 /tmp/remarkable-hugo.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl restart remarkable-hugo
```

```sh
sudo install -m 644 /tmp/remarkable-hugo.developerjesse.xyz.conf /etc/nginx/sites-available/
sudo nginx -t
sudo systemctl reload nginx
```

## GitHub settings (jessgusclark/remarkable-hugo)

- Secret: `DEPLOY_SSH_KEY`
- Variables: `DEPLOY_HOST=46.101.213.32`, `DEPLOY_USER=deploy-remarkable-hugo`, `DEPLOY_KNOWN_HOSTS` (same value as daily-brief)

This repo is public, so workflow logs are public. Secrets are masked; the
variables above are not secret.

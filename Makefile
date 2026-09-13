.PHONY: dev code test check up seed logs down reset iam-caddy

dev:             ## Everything: clone, credentials, start. UI at http://localhost:8200
	@echo '[make dev] ./scripts/dev-up.sh'
	./scripts/dev-up.sh

code:            ## Print the current break-glass sign-in code
	@echo '[make code] ./scripts/dev-code.sh'
	./scripts/dev-code.sh

# Both images install dependencies at build time, so a new one in package.json is missing
# until they are rebuilt — and the failure is a module-not-found at boot with nothing pointing
# at the cause. Building first costs seconds when the cache is warm and removes the trap.
test:            ## Run the suite on Linux, where SO_PEERCRED and sops exist
	@echo '[make test] docker compose build --progress=plain test && docker compose run --rm test'
	docker compose build --progress=plain test && docker compose run --rm test

check:           ## Lint and typecheck on the host, then the full suite in the container
	@echo '[make check] pnpm lint && pnpm typecheck && docker compose build --progress=plain test && docker compose run --rm test'
	pnpm lint && pnpm typecheck && docker compose build --progress=plain test && docker compose run --rm test

iam-caddy:       ## Local https://iam.anudeep.pro via Caddy (mkcert); needed for IAM SSO from Docker
	@echo '[make iam-caddy] ./scripts/iam-caddy.sh'
	./scripts/iam-caddy.sh

up:              ## Start the service; UI at http://localhost:8200
	@echo '[make up] build app (plain progress), up -d, logs -f'
	BUILD_SHA=$$(git rev-parse HEAD) docker compose build --progress=plain app && docker compose up -d app && docker compose ps && docker compose logs -f app

seed:            ## Clone the configured registry into the app volume
	@echo '[make seed] docker compose run seed.sh'
	docker compose run --rm -v ./scripts:/app/scripts:ro --entrypoint sh app /app/scripts/seed.sh

logs:
	@echo '[make logs] docker compose logs -f app'
	docker compose logs -f app

down:
	@echo '[make down] docker compose down'
	docker compose down

# .env is left alone: it holds the git remote and the deploy key path, which nothing can derive
# and which deleting them disarms publishing silently -- dev-up.sh writes empty placeholders
# back, and compose then mounts a DIRECTORY where the deploy key belongs, so every push fails
# with "Permission denied (publickey)" long after the reset that caused it.
#
# The age key in there is the operator's own now that nothing generates one, so it is exactly
# the kind of value a reset must not touch.
reset:           ## Throw away the local repository, drafts and credentials, and start over
	@echo '[make reset] docker compose down -v (leaves .env)'
	docker compose down -v
	@# Compose creates a directory for a bind mount whose source is missing. Left behind, it is
	@# the thing ssh is handed as a private key on the next run.
	rmdir deploy/no-deploy-key 2>/dev/null || true
	@echo "Removed the local volumes. .env is untouched, so the git remote, deploy key and"
	@echo "age key are still there. Run 'make dev' to clone the registry again."

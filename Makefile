.PHONY: dev code test check up seed logs down reset

dev:             ## Everything: seed, credentials, start. UI at http://localhost:8200
	./scripts/dev-up.sh

code:            ## Print the current break-glass sign-in code
	./scripts/dev-code.sh

# Both images install dependencies at build time, so a new one in package.json is missing
# until they are rebuilt — and the failure is a module-not-found at boot with nothing pointing
# at the cause. Building first costs seconds when the cache is warm and removes the trap.
test:            ## Run the suite on Linux, where SO_PEERCRED and sops exist
	docker compose build test && docker compose run --rm test

check:           ## Lint and typecheck on the host, then the full suite in the container
	pnpm lint && pnpm typecheck && docker compose build test && docker compose run --rm test

up:              ## Start the service; UI at http://localhost:8200
	docker compose build app && docker compose up -d app && docker compose logs -f app

seed:            ## Create a sample config repository inside the app volume
	docker compose run --rm -v ./scripts:/app/scripts:ro --entrypoint sh app /app/scripts/seed.sh

logs:
	docker compose logs -f app

down:
	docker compose down

# The repository, its age key and the break-glass credential are all regenerable, so reset takes
# them. The git remote and the deploy key path are not: nothing can derive them, and deleting
# .env wholesale disarmed publishing without saying so - dev-up.sh wrote empty placeholders back,
# and compose then mounted a DIRECTORY where the deploy key belongs, so every push failed with
# "Permission denied (publickey)" long after the reset that caused it.
reset:           ## Throw away the local repository, drafts and credentials, and start over
	docker compose down -v
	./scripts/env-keep.sh .env CONFIG_GIT_REMOTE CONFIG_DEPLOY_KEY CONFIG_REPO_WEB_URL
	@# Compose creates a directory for a bind mount whose source is missing. Left behind, it is
	@# the thing ssh is handed as a private key on the next run.
	rmdir deploy/no-deploy-key 2>/dev/null || true
	@echo "Removed the local volumes and the generated credentials. Kept the git remote and"
	@echo "deploy key path in .env. Run 'make dev' to rebuild from nothing."

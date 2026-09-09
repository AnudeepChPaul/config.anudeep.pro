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

# .env is left alone: it holds the git remote and the deploy key path, which nothing can derive
# and which deleting them disarms publishing silently -- dev-up.sh writes empty placeholders
# back, and compose then mounts a DIRECTORY where the deploy key belongs, so every push fails
# with "Permission denied (publickey)" long after the reset that caused it.
#
# The age key in there can outlive the volume, so dev-up.sh overwrites it whenever it seeds.
reset:           ## Throw away the local repository, drafts and credentials, and start over
	docker compose down -v
	@# Compose creates a directory for a bind mount whose source is missing. Left behind, it is
	@# the thing ssh is handed as a private key on the next run.
	rmdir deploy/no-deploy-key 2>/dev/null || true
	@echo "Removed the local volumes. .env is untouched, so the git remote, deploy key and"
	@echo "age key are still there. Run 'make dev' to rebuild the repository."

.PHONY: dev code test check up seed logs down reset

dev:             ## Everything: seed, credentials, start. UI at http://localhost:8200
	./scripts/dev-up.sh

code:            ## Print the current break-glass sign-in code
	./scripts/dev-code.sh

test:            ## Run the suite on Linux, where SO_PEERCRED and sops exist
	docker compose run --rm test

check:           ## Lint and typecheck on the host, then the full suite in the container
	pnpm lint && pnpm typecheck && docker compose run --rm test

up:              ## Start the service; UI at http://localhost:8200
	docker compose up -d app && docker compose logs -f app

seed:            ## Create a sample config repository inside the app volume
	docker compose run --rm -v ./scripts:/app/scripts:ro --entrypoint sh app /app/scripts/seed.sh

logs:
	docker compose logs -f app

down:
	docker compose down

reset:           ## Throw away the local repository, drafts and credentials, and start over
	docker compose down -v
	rm -f .env
	@echo "Removed the local volumes and .env. Run 'make dev' to rebuild from nothing." 

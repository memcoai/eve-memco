# eve-memco tasks. Every multi-step operation is a chained `npm run` script:
# .npmrc sets `ignore-scripts=true`, so npm never fires pre/post lifecycle
# hooks, and a step written that way would be skipped behind a green build.

.DEFAULT_GOAL := help
NPM ?= npm
RUN := $(NPM) run --silent

.PHONY: help install lint format typecheck test check build clean

help:  ## Show this help
	@grep -hE '^[a-z][a-z-]*:.*?## ' $(MAKEFILE_LIST) \
		| awk -F':.*?## ' '{printf "  \033[36m%-10s\033[0m %s\n", $$1, $$2}'

install:  ## Install the development toolchain from the lockfile
	$(NPM) ci

lint:  ## Check formatting
	$(RUN) lint

format:  ## Apply formatting
	$(RUN) format

typecheck:  ## Strict type check of the provider and the tests
	$(RUN) typecheck

test:  ## Run the suite on node:test
	$(RUN) test

check: lint typecheck test  ## Everything CI runs

build:  ## Build the package and the npm tarball
	$(RUN) build
	$(NPM) pack

clean:  ## Remove build artefacts
	rm -rf dist build *.tgz *.tsbuildinfo

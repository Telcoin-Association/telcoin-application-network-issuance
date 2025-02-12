# Application configuration
# Override these variables when running make commands
#
# Example: make build APP_NAME=custom-name
APP_NAME ?= tan-issuance-calc
APP_PORT ?= 3000
NODE_ENV ?= development

# Get the current directory name as the default tag
DOCKER_TAG ?= $(shell basename $(CURDIR))

# Ensure that if any command in a pipe fails, the entire pipe returns a failure
SHELL := /bin/bash
.SHELLFLAGS := -o pipefail -c

# Declare our targets as phony since they don't represent files
.PHONY: build up run stop clean help logs test shell

# Default target when just running 'make'
.DEFAULT_GOAL := help

# Build the Docker image
build:
	@echo "Building Docker image: $(APP_NAME):$(DOCKER_TAG)"
	docker build \
		--build-arg NODE_ENV=$(NODE_ENV) \
		-t $(APP_NAME):$(DOCKER_TAG) \
		.

# Start an interactive session in a new container
up:
	@echo "Starting interactive container session"
	docker run -it --rm \
		--name $(APP_NAME)_interactive \
		-p $(APP_PORT):$(APP_PORT) \
		-e NODE_ENV=$(NODE_ENV) \
		-v $$(pwd):/app \
		$(APP_NAME):$(DOCKER_TAG) \
		/bin/bash

# Run the container in detached mode
run:
	@echo "Starting container: $(APP_NAME)"
	docker run -d \
		--name $(APP_NAME) \
		-p $(APP_PORT):$(APP_PORT) \
		-e NODE_ENV=$(NODE_ENV) \
		$(APP_NAME):$(DOCKER_TAG)

# Stop and remove the container
stop:
	@echo "Stopping container: $(APP_NAME)"
	@docker stop $(APP_NAME) || true
	@docker rm $(APP_NAME) || true

# Clean up images and containers
clean: stop
	@echo "Cleaning up Docker resources"
	@docker rmi $(APP_NAME):$(DOCKER_TAG) || true

# View container logs
logs:
	@echo "Showing logs for: $(APP_NAME)"
	docker logs -f $(APP_NAME)

# Open an interactive shell in the container
shell:
	@echo "Opening shell in container: $(APP_NAME)"
	docker exec -it $(APP_NAME) /bin/sh

# Run tests in a new container
test:
	@echo "Running tests in container"
	docker run --rm \
		-e NODE_ENV=test \
		$(APP_NAME):$(DOCKER_TAG) \
		npm test

# Display help information about available commands
help:
	@echo "Available commands:"
	@echo "  make build     - Build the Docker image"
	@echo "  make run      - Run the container in detached mode"
	@echo "  make stop     - Stop and remove the container"
	@echo "  make clean    - Stop container and remove image"
	@echo "  make logs     - View container logs"
	@echo "  make shell    - Open a shell in the running container"
	@echo "  make test     - Run tests in a new container"
	@echo "  make help     - Show this help message"
	@echo ""
	@echo "Environment variables:"
	@echo "  APP_NAME    - Application name (default: typescript-app)"
	@echo "  APP_PORT    - Port to expose (default: 3000)"
	@echo "  DOCKER_TAG  - Docker image tag (default: current directory name)"
	@echo "  NODE_ENV    - Node environment (default: production)"

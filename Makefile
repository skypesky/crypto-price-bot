.PHONY: install lint build dev start stop test help

PROCESS_NAME := crypto-price-bot
START_CMD := pm2 start index.js --interpreter bun --name $(PROCESS_NAME)

help:
	@echo "Usage:"
	@echo "  make install      - Install dependencies (bun install)"
	@echo "  make lint         - Run lint check"
	@echo "  make dev          - Start development mode (bun index.js)"
	@echo "  make start        - Start production mode (pm2, kills old)"
	@echo "  make stop         - Stop service (pm2 delete)"
	@echo "  make restart       - Restart service"
	@echo "  make logs         - View pm2 logs"
	@echo "  make test         - Run tests"

install:
	@echo "Installing dependencies..."
	@bun install

lint:
	@echo "Running lint check..."
	@echo "No lint configured"

build:
	@echo "No build step required"

dev:
	@echo "Starting development mode..."
	@bun index.js

start: kill-old
	@echo "Starting production mode..."
	@$(START_CMD)

kill-old:
	@if pm2 list | grep -q $(PROCESS_NAME); then \
		echo "Stopping old instance..."; \
		pm2 delete $(PROCESS_NAME) 2>/dev/null || true; \
	fi

stop:
	@echo "Stopping service..."
	@pm2 delete $(PROCESS_NAME) 2>/dev/null || true

restart: stop start
	@echo "Service restarted"

logs:
	@pm2 logs $(PROCESS_NAME)

test:
	@echo "Running tests..."
	@bun test

.PHONY: help install lint check test vsix verify

NPM ?= npm

help:
	@printf 'Targets: install, lint, check, test, vsix, verify\n'

install:
	$(NPM) ci

lint:
	$(NPM) run lint

check:
	$(NPM) run check

test:
	$(NPM) test

vsix:
	$(NPM) run vsix

verify: lint check test vsix

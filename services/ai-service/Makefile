# Local shortcuts; the container runs uvicorn directly (see Dockerfile).
PY := .venv/bin/python

.PHONY: dev start worker test install

dev:      ## API on :3004, reloads on code changes
	$(PY) -m uvicorn app.main:app --host 0.0.0.0 --port 3004 --reload

start:    ## API on :3004, no reload
	$(PY) -m uvicorn app.main:app --host 0.0.0.0 --port 3004

worker:   ## legacy duplicate worker (only used when incident REPORT_VERIFICATION_ENABLED is off)
	$(PY) -m app.worker

test:
	$(PY) -m pytest -q

install:  ## create .venv and install requirements
	test -d .venv || python3 -m venv .venv
	$(PY) -m pip install -r requirements.txt

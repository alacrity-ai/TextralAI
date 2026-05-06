FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

COPY requirements.txt .
RUN pip install -r requirements.txt

COPY app ./app
# Phase 5: corpus profile YAMLs come from packages/corpus-profiles.
# `make build-ingest` mirrors them into apps/ingest/profiles/ before
# running wrangler containers build, so the COPY here lands them at
# /app/profiles in the image. The Container's loader checks
# TEXTRAL_CORPUS_PROFILES_DIR first, then /app/profiles, then walks.
COPY profiles ./profiles

EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]

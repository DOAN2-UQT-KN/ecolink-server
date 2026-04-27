# Build from DA2-backend root:
#   docker build -f services/ai-service/Dockerfile .

FROM python:3.12-slim

WORKDIR /app

RUN useradd --create-home --uid 1001 --shell /usr/sbin/nologin appuser

COPY services/ai-service/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY services/ai-service/app ./app

USER appuser
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

EXPOSE 3004
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "3004"]

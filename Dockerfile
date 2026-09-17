FROM node:20-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-venv \
    python3-pip \
    libgomp1 \
    libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY passenger-counter/requirements.txt passenger-counter/requirements.txt
RUN python3 -m venv /app/passenger-counter/.venv \
    && /app/passenger-counter/.venv/bin/pip install --no-cache-dir --upgrade pip \
    && /app/passenger-counter/.venv/bin/pip install --no-cache-dir torch --index-url https://download.pytorch.org/whl/cpu \
    && /app/passenger-counter/.venv/bin/pip install --no-cache-dir -r passenger-counter/requirements.txt

COPY . .

ENV PYTHON_BIN=/app/passenger-counter/.venv/bin/python3
ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]

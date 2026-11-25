FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
ENV PORT=8080 DB_FILE=/data/invoiceguard.db
CMD ["node","src/app.js"]

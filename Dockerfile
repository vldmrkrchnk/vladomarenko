# Multi-stage build for Krapral Telegram Bot
FROM node:20-slim AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./
COPY tsconfig.json ./

# Install dependencies
RUN npm ci

# Copy source files
COPY src/ ./src/
COPY identity.txt ./
COPY users.json ./

# Build TypeScript
RUN npm run build

# Production stage
FROM node:20-slim

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install production dependencies only
RUN npm ci --only=production

# Copy built files from builder
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/identity.txt ./
COPY --from=builder /app/users.json ./

# Create directory for log files (if using local storage)
RUN mkdir -p /app/logs

# Set environment to production
ENV NODE_ENV=production

# Run the bot
CMD ["node", "dist/bot.js"]


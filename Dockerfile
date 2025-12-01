# ============================================
# GEBETA DELIVERY BACKEND - Dockerfile
# ============================================

# Use official Node.js LTS version
FROM node:20-alpine AS base

# Install dumb-init for proper signal handling
RUN apk add --no-cache dumb-init

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# ============================================
# DEVELOPMENT STAGE
# ============================================
FROM base AS development

# Install all dependencies (including devDependencies)
RUN npm ci

# Copy application code
COPY . .

# Expose port
EXPOSE 3000

# Run with nodemon for development
CMD ["npm", "run", "dev"]

# ============================================
# PRODUCTION STAGE
# ============================================
FROM base AS production

# Set NODE_ENV
ENV NODE_ENV=production

# Install production dependencies only
RUN npm ci --only=production && npm cache clean --force

# Create non-root user for security
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

# Copy application code
COPY --chown=nodejs:nodejs . .

# Create logs directory
RUN mkdir -p logs && chown nodejs:nodejs logs

# Switch to non-root user
USER nodejs

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=40s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

# Use dumb-init to handle signals properly
ENTRYPOINT ["dumb-init", "--"]

# Start the application
CMD ["node", "server.js"]



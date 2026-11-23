# Multi-stage build for smaller image size
FROM node:22-bookworm-slim AS base

# Install Chromium and dependencies in a single layer
FROM base AS dependencies

RUN apt-get update && apt-get install -y --no-install-recommends \
    # Chromium
    chromium \
    chromium-sandbox \
    # Core dependencies
    ca-certificates \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libatspi2.0-0 \
    libc6 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libexpat1 \
    libfontconfig1 \
    libgbm1 \
    libgcc-s1 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libstdc++6 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxi6 \
    libxrandr2 \
    libxrender1 \
    libxss1 \
    libxtst6 \
    # Fonts
    fonts-ipafont-gothic \
    fonts-wqy-zenhei \
    fonts-thai-tlwg \
    fonts-kacst \
    fonts-freefont-ttf \
    # Virtual display
    xvfb \
    dumb-init \
    # Cleanup
    && rm -rf /var/lib/apt/lists/* \
    && apt-get clean \
    && apt-get autoremove -y

# Production stage
FROM dependencies AS production

# Create non-root user for security
RUN groupadd -r pptruser && useradd -r -g pptruser -G audio,video pptruser \
    && mkdir -p /home/pptruser/Downloads \
    && chown -R pptruser:pptruser /home/pptruser

# Set working directory
WORKDIR /app

# Set environment variables
ENV DISPLAY=:99 \
    DEBIAN_FRONTEND=noninteractive \
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    NODE_ENV=production \
    HOME=/home/pptruser

# Copy package files
COPY --chown=pptruser:pptruser package*.json ./

# Install dependencies
RUN npm ci --omit=dev && npm cache clean --force

# Copy application code
COPY --chown=pptruser:pptruser . .

# Create debug directory
RUN mkdir -p /app/debug && chown -R pptruser:pptruser /app/debug

# Create startup script with better error handling
RUN echo '#!/bin/bash\n\
set -e\n\
\n\
# Function to cleanup processes\n\
cleanup() {\n\
    echo "Received shutdown signal, cleaning up..."\n\
    if [ ! -z "$NODE_PID" ]; then\n\
        kill -TERM "$NODE_PID" 2>/dev/null || true\n\
        wait "$NODE_PID" 2>/dev/null || true\n\
    fi\n\
    if [ ! -z "$XVFB_PID" ]; then\n\
        kill -TERM "$XVFB_PID" 2>/dev/null || true\n\
    fi\n\
    echo "Cleanup complete"\n\
    exit 0\n\
}\n\
\n\
trap cleanup SIGTERM SIGINT SIGQUIT\n\
\n\
echo "Starting Xvfb..."\n\
rm -f /tmp/.X99-lock\n\
Xvfb :99 -screen 0 1920x1080x24 -ac +extension GLX +render -noreset &\n\
XVFB_PID=$!\n\
\n\
# Wait for Xvfb to be ready\n\
sleep 2\n\
\n\
# Verify Xvfb is running\n\
if ! kill -0 $XVFB_PID 2>/dev/null; then\n\
    echo "ERROR: Xvfb failed to start"\n\
    exit 1\n\
fi\n\
\n\
echo "Xvfb started successfully (PID: $XVFB_PID)"\n\
echo "Starting Node.js application..."\n\
\n\
# Start Node.js application\n\
node index.js &\n\
NODE_PID=$!\n\
\n\
echo "Node.js application started (PID: $NODE_PID)"\n\
\n\
# Wait for the Node process\n\
wait $NODE_PID\n\
NODE_EXIT_CODE=$?\n\
\n\
echo "Node.js application exited with code $NODE_EXIT_CODE"\n\
cleanup\n\
' > /app/start.sh && chmod +x /app/start.sh && chown pptruser:pptruser /app/start.sh

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD node -e "require('http').get('http://localhost:3000/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})" || exit 1

# Switch to non-root user
USER pptruser

# Expose port
EXPOSE 3000

# Use dumb-init as entrypoint
ENTRYPOINT ["dumb-init", "--"]

# Run the application
CMD ["/app/start.sh"]
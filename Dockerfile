# Node image for TAN issuance
FROM node:18-bookworm

# Create a non-root user
RUN useradd -u 1111 -U -ms /bin/bash nonroot
USER nonroot

# Create and set working directory owned by non-root user
WORKDIR /app
RUN chown nonroot /app

# Switch to non-root user
USER nonroot

# Copy package files first to leverage Docker cache
COPY --chown=nonroot package*.json ./

# Install dependencies
RUN yarn

# Copy source code and tsconfig
COPY --chown=nonroot . .

# empty referrals to build
RUN touch src/data/users_wallets_referrals.json

# Build TypeScript code
RUN yarn build

# install foundry
RUN curl -L https://foundry.paradigm.xyz | bash && \
    ~/.foundry/bin/foundryup

# Expose the port your application runs on (adjust as needed)
EXPOSE 3000

# Start the application
CMD ["node", "dist/index.js"]

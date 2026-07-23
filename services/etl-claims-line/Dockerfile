FROM node:22
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY --chown=node:node . .
RUN mkdir -p /app/data && chown node:node /app/data
USER node
CMD ["node", "vectorize.js"]

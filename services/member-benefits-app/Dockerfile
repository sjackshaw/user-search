FROM node:22
WORKDIR /usr/src/app
COPY package*.json ./
RUN npm ci --only=production
COPY --chown=node:node . .
RUN mkdir -p /usr/src/app/generated-docs && chown node:node /usr/src/app/generated-docs
USER node
EXPOSE 3002
CMD ["node", "src/index.js"]

FROM node:22
WORKDIR /usr/src/app
COPY package*.json ./
RUN npm ci --only=production
COPY --chown=node:node . .
USER node
EXPOSE 3001
CMD ["node", "index.js"]

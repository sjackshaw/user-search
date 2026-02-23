FROM node:22
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
RUN mkdir -p /app/data
CMD ["node", "vectorize.js"]

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY db ./db
COPY src ./src
EXPOSE 3000
CMD ["node", "src/server.js"]

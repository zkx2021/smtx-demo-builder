FROM mcr.microsoft.com/azurelinux/base/nodejs:24.22 AS build
WORKDIR /app
COPY democenter/package*.json ./democenter/
RUN cd democenter && npm ci
COPY src ./src
COPY democenter ./democenter
RUN cd democenter && npm run build

FROM mcr.microsoft.com/azurelinux/base/nodejs:24.22
WORKDIR /app/democenter
ENV NODE_ENV=production PORT=3000 DATA_DIR=/data/demos
COPY democenter/package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/democenter/dist ./dist
COPY democenter/server ./server
EXPOSE 3000
CMD ["node", "server/index.mjs"]

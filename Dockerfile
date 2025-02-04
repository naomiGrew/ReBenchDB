FROM postgres:15-bullseye
# this allows the setup to ignore all of the ubuntu OS setup
# thats not needed for this docker image (Time Zone for example)
ARG DEBIAN_FRONTEND=noninteractive

# tools needed for docker setup
RUN apt-get update && apt-get install -y apt-utils curl bash sudo

ENV TZ=UTC
RUN ln -snf /usr/share/zoneinfo/$TZ /etc/localtime && echo $TZ > /etc/timezone

# Add Node.js repo
RUN curl -sL https://deb.nodesource.com/setup_19.x | bash -

RUN sh -c 'echo "deb http://cloud.r-project.org/bin/linux/debian bullseye-cran40/" > /etc/apt/sources.list.d/r-project.list' && \
    apt-key adv --keyserver keyserver.ubuntu.com --recv-key '95C0FAF38DB3CCAD0C080A7BDC78B2DDEABC47B7'


# R, Node.js, PostgreSQL, headers for R packages
RUN apt-get update && apt-get install -y \
    r-base build-essential nodejs \
    libfontconfig1-dev \
    libpq-dev

# Copy only the install.R to enable caching
RUN mkdir -p /project/src/stats/
COPY ./src/stats/install.R /project/src/stats/

# Installing R libraries
RUN Rscript /project/src/stats/install.R


# Copy only package.json to enable caching
COPY ./package.json ./package-lock.json /project/

# Set the working dir to the project & install and compile all dependency
WORKDIR /project/

RUN npm ci --ignore-scripts .

ENV POSTGRES_PASSWORD=docker
ENV POSTGRES_USER=docker

# Basic Configuration
ENV RDB_USER=docker
ENV RDB_PASS=docker
ENV RDB_DB=docker
ENV REFRESH_SECRET=refresh

# open TCP/Project port
EXPOSE 33333

# Generate Script to start the image
RUN echo 'echo Starting ReBenchDB\n\
docker-entrypoint.sh postgres &\n\
DEV=true npm run start' > ./start-server.sh

# all of the project files will be copyed to a new dir called project
COPY . /project

RUN npm run compile

CMD ["bash", "./start-server.sh" ]

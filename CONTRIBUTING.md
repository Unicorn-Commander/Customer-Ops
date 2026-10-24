# Contributing

Customer-Ops is a NestJS/Prisma backend and a Next.js frontend. Keep changes focused, preserve workspace and federation boundaries, and avoid committing environment files or credentials.

## Local workflow

Use the self-host Docker stack in [README.md](README.md) for the complete app, or run the backend and frontend from source with the documented environment templates.

Before opening a pull request, run the checks for the area you changed:

~~~bash
cd backend
npm ci
npm run build
npm test
npm run lint
~~~

~~~bash
cd frontend
npm ci
npm run build
npm run lint
~~~

Describe behavior changes, migrations, configuration changes, and any required integration setup in the pull request. Never include real tokens, passwords, private hostnames, or customer data in commits, logs, fixtures, or screenshots.

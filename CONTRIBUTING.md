# Contributing

sesame is a personal project that I maintain in my spare time. Bug reports, fixes and ideas are welcome, but replies may take a while.

## Issues

Before you open an issue, check the open and recently closed ones. A useful bug report includes:

- the steps to reproduce it;
- the commit you're on and anything you changed;
- anything unusual about your AWS account, Region or identity provider.

Don't report security problems in a public issue. See [SECURITY.md](SECURITY.md).

## Pull requests

For anything bigger than a small fix, open an issue first so we can agree on the approach.

1. Fork the repository and branch from `main`.
2. Keep the change focused. Please don't reformat unrelated code.
3. Make sure `pnpm test`, `pnpm typecheck` and `pnpm lint` pass.
4. If the change affects cost, behavior or architecture, update the matching page in [`docs`](docs).
5. Open the pull request and describe what changed and why.

By contributing, you agree that your contribution is licensed under the project's [MIT License](LICENSE).

## Code of conduct

This project follows its [Code of Conduct](CODE_OF_CONDUCT.md).

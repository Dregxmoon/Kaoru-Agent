# Scripts de proyecto (`scripts/`)

## `release.sh`

Flujo de release: sube la versión semver del `package.json` (`patch` | `minor` | `major`), crea el tag
`vX.Y.Z`, hace push (guarda contra tags duplicados). El tag dispara el job de **release automática**
de la CI (build portable `.exe` + GitHub Release).

```bash
bash scripts/release.sh minor
```

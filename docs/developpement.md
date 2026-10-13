# Développement

--8<-- "README.md:developpement"

## Documentation

Cette documentation est construite avec MkDocs (thème Material) :

```bash
uv run --with mkdocs-material mkdocs serve          # aperçu local sur http://127.0.0.1:8000
uv run --with mkdocs-material mkdocs build --strict # comme la CI : échoue sur lien mort
```

Toute nouvelle fonction est documentée dans `docs/` (ou dans la section du
README reprise ici) et la construction stricte doit passer.

## Licence

[MIT](https://github.com/Mathide-Team/IAO/blob/dev/LICENSE).

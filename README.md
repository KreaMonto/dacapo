# Encore

**Encore** es un editor de partituras open source multiplataforma, construido en Rust y Tauri. Su objetivo es ofrecer una aplicación ligera, segura y extensible para componer, editar y exportar partituras musicalmente correctas.

## Características principales

- Editor visual de partituras con pentagrama interactivo.
- Inserción y edición de notas, silencios, compases y armaduras.
- Exportación a MusicXML y PDF.
- Importación de partituras en MusicXML.
- Reproducción básica de audio con clic interno.
- Interfaz nativa multiplataforma gracias a Tauri.

## Tecnología

- Backend: Rust
- UI: Tauri + tecnologías web (HTML/CSS/JavaScript o framework ligero)
- Formatos de datos: MusicXML, JSON propio
- Renderizado: SVG/PDF

## Estructura del repositorio

- `src-tauri/`: código Rust y configuración de Tauri.
- `src/`: frontend web de la aplicación.
- `docs/`: documentación técnica y guías.
- `README.md`: visión general del proyecto.
- `CONTRIBUTING.md`: guía para colaboradores.
- `LICENSE`: licencia open source.

## Documentación disponible

- `docs/INSTALLATION.md` — instalación y configuración local.
- `docs/USAGE.md` — uso principal de la aplicación.
- `docs/ARCHITECTURE.md` — diseño técnico y arquitectura del sistema.
- `docs/ROADMAP.md` — plan de desarrollo y objetivos.
- `docs/STYLE_GUIDE.md` — estilo de código y contribuciones.

## Cómo contribuir

1. Clona el repositorio.
2. Revisa `CONTRIBUTING.md`.
3. Abre un issue si quieres proponer una mejora o reportar un error.
4. Crea una rama con nombre claro.
5. Envía un pull request con descripción y pruebas.

## Licencia

Este proyecto está bajo licencia MIT. Consulta `LICENSE` para más detalles.

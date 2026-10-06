"""Axudas para as probas de navegador (Playwright)."""


def base_handle(route, port=None):
    """Calquera petición que non vaia ao sitio de proba aborta: a app non debe depender de terceiros."""
    return route.abort()

# Alcance del proyecto y uso autorizado

DoubleMusic es un servidor para organizar y reproducir una biblioteca musical propia. Está pensado para grabaciones propias, contenidos de dominio público o material cuyo uso esté permitido por la licencia, autorización o excepción legal aplicable.

La biblioteca local está activada por defecto. Las conexiones externas están desactivadas y se habilitan expresamente mediante `external.enabled`. La API permite desarrollar extensiones para interfaces y servicios cuyo acceso esté autorizado. El administrador configura esas conexiones y sus credenciales fuera del repositorio.

El repositorio distribuye el servidor, sus contratos de API y un ejemplo que genera su propio audio de prueba. No distribuye grabaciones comerciales ni conectores específicos de plataformas. Las grabaciones que el administrador coloque en su biblioteca son independientes del código del proyecto.

Un interruptor o una API genérica no certifican los permisos de cada contenido ni las condiciones de cada servicio. Para una conexión concreta deben respetarse las autorizaciones y condiciones aplicables. La [OMPI explica la relación entre derechos, licencias y usos permitidos](https://www.wipo.int/en/web/copyright/faq-copyright); en España, el [artículo 17 de la Ley de Propiedad Intelectual](https://www.boe.es/buscar/act.php?id=BOE-A-1996-8930#a17) establece los derechos de explotación y contempla las excepciones previstas en la ley.

Los derechos sobre el contenido, las condiciones de un servicio externo y las licencias de las dependencias son cuestiones distintas. La documentación de la API no concede derechos sobre catálogos ajenos ni sustituye una revisión del uso concreto.

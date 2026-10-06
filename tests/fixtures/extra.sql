-- Datos extra só para as probas (por riba do seed real do repo).
INSERT OR IGNORE INTO media (id,provider,media_kind,title,url) VALUES (5,'pdf','pdf','Local','http://localhost:9/a.pdf');
INSERT OR IGNORE INTO media (id,provider,media_kind,title,url) VALUES (6,'pdf','pdf','Publico','https://www.w3.org/WAI/WCAG21/Techniques/pdf/img/table-word.jpg');
INSERT OR IGNORE INTO media (id,provider,media_kind,title,url,description,author_or_source,thumbnail_url) VALUES (7,'spotify','spotify','Magán - Pandereteiras Soalleira','https://open.spotify.com/track/2emBaex7di4V1uzNFxB3PH?si=7db1a2440bf64f0d','Pandereteiras Soalleira \ Magán \ Song \ 2026','Pandereteiras Soalleira','https://i.scdn.co/image/ab67616d0000b273d772a44d66c6d560d61e681e');
INSERT OR IGNORE INTO melodies (id,territory_id,rhythm,rhythm_key,number,notes) VALUES (2,'par:3603705','Muiñeira','muineira',2,'unha nota');
INSERT OR IGNORE INTO melodies (id,territory_id,rhythm,rhythm_key,number,notes) VALUES (4,'par:3601505','Xota','xota',1,NULL);
INSERT OR IGNORE INTO melodies (id,territory_id,rhythm,rhythm_key,number,notes) VALUES (5,'par:3603705','Xota','xota',1,NULL);

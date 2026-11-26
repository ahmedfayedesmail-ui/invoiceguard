// Localized landing pages (ES, DE, FR, IT, NL, PL). Hand-written native-quality copy, not machine output.
// The honesty gates are identical in every language: one business day is Amazon policy (never "the law"),
// pilot status is stated, no tax advice, unverified countries are said to wait rather than guess.
import { esc, CSS } from './site.js';

const NAV = {
  es: ['Muestra en vivo', 'Cómo funciona', 'Preguntas', 'Artículos', 'Privacidad', 'Contacto', 'Abrir la app'],
  de: ['Live-Demo', 'So funktioniert es', 'FAQ', 'Artikel', 'Datenschutz', 'Kontakt', 'App öffnen'],
  fr: ['Démo en direct', 'Comment ça marche', 'FAQ', 'Articles', 'Confidentialité', 'Contact', "Ouvrir l'app"],
  it: ['Demo dal vivo', 'Come funziona', 'FAQ', 'Articoli', 'Privacy', 'Contatti', "Apri l'app"],
  nl: ['Live voorbeeld', 'Zo werkt het', 'FAQ', 'Artikelen', 'Privacy', 'Contact', 'App openen'],
  pl: ['Prezentacja na żywo', 'Jak to działa', 'FAQ', 'Artykuły', 'Prywatność', 'Kontakt', 'Otwórz aplikację'],
};
const FOOT = {
  es: ['Inicio', 'Preguntas', 'Artículos', 'Privacidad', 'Contacto', 'InvoiceGuard es una herramienta en fase piloto. No es asesoramiento fiscal ni legal.'],
  de: ['Startseite', 'FAQ', 'Artikel', 'Datenschutz', 'Kontakt', 'InvoiceGuard ist ein Pilotprojekt. Keine Steuer- oder Rechtsberatung.'],
  fr: ['Accueil', 'FAQ', 'Articles', 'Confidentialité', 'Contact', "InvoiceGuard est un outil en phase pilote. Ce n'est pas un conseil fiscal ou juridique."],
  it: ['Home', 'FAQ', 'Articoli', 'Privacy', 'Contatti', 'InvoiceGuard è uno strumento in fase pilota. Non è consulenza fiscale o legale.'],
  nl: ['Home', 'FAQ', 'Artikelen', 'Privacy', 'Contact', 'InvoiceGuard is een tool in pilootfase. Het is geen fiscaal of juridisch advies.'],
  pl: ['Strona główna', 'FAQ', 'Artykuły', 'Prywatność', 'Kontakt', 'InvoiceGuard to narzędzie w fazie pilotażowej. To nie jest porada podatkowa ani prawna.'],
};
export const LOCALE_PATHS = Object.keys(NAV); // ['es','de','fr','it','nl','pl']

const pageLoc = (title, body, desc, L, lang) => `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><meta name="description" content="${esc(desc)}"><meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(desc)}"><meta property="og:type" content="website"><meta name="twitter:card" content="summary"><link rel="icon" type="image/svg+xml" href="/favicon.svg"><style>${CSS}</style></head><body>
<header><a class="logo" href="/${lang}">Invoice<b>Guard</b></a><span class="sp"></span><nav><a href="/sample">${NAV[lang][0]}</a><a href="/${lang}#how">${NAV[lang][1]}</a><a href="/faq">${NAV[lang][2]}</a><a href="/articles">${NAV[lang][3]}</a><a href="/privacy">${NAV[lang][4]}</a><a href="/contact">${NAV[lang][5]}</a></nav><a class="btn" href="/app">${NAV[lang][6]}</a></header>
<main>${body}</main>
<footer><a href="/${lang}">${FOOT[lang][0]}</a><a href="/faq">${FOOT[lang][1]}</a><a href="/articles">${FOOT[lang][2]}</a><a href="/privacy">${FOOT[lang][3]}</a><a href="/contact">${FOOT[lang][4]}</a><div style="margin-top:8px">${esc(FOOT[lang][5])}</div><div style="margin-top:6px;font-size:13px"><a href="/">EN</a> · ${LOCALE_PATHS.map(l => l === lang ? `<b>${l.toUpperCase()}</b>` : `<a href="/${l}">${l.toUpperCase()}</a>`).join(' · ')}</div></footer></body></html>`;

const L = {
  es: {
    title: 'InvoiceGuard: facturas B2B para vendedores de Amazon, revisadas antes de salir',
    desc: 'InvoiceGuard prepara y revisa las facturas B2B de vendedores de Amazon en la UE. Fase piloto, honesta sobre lo que funciona hoy.',
    h1: 'Facturas de Amazon Business, sin la parte manual.',
    lead: 'Amazon dice que la facturación es automática. Muchos vendedores siguen haciendo cada factura a mano. InvoiceGuard toma el informe de pedidos que descargas de Seller Central, prepara una factura por cada pedido empresarial y la revisa antes de que salga: el NIF del comprador, los datos obligatorios, la numeración, el plazo. Si algo no cuadra, se detiene y te dice qué corregir, en palabras claras.',
    rule: 'España: el plazo de un día laborable de Amazon es política de Amazon, y la declaración Verifactu está en camino.',
    note: '<b>Estado honesto:</b> InvoiceGuard es un piloto. No está conectado con Amazon. Subes tu propio informe de pedidos y subes tú mismo las facturas terminadas a Amazon. Los datos de muestra de la app son inventados y nada de ellos se envía a Amazon. Lo decimos en cada pantalla que muestra datos de muestra. Todavía no hemos probado con un archivo real de Seller Central.',
    familiarH: '¿Te suena?',
    familiar: ['La facturación de Amazon está activada, pero las facturas nunca llegan, y sigues haciéndolas a mano.', 'Un pedido Paneuropeo muestra tu CIF español, el siguiente un NIF alemán, y nunca está claro cuál va en la factura.', 'Verifactu está en camino en España, y nadie dice con claridad a cuáles de tus facturas les afecta.'],
    familiarOut: 'Estos son los hilos que los vendedores publican en los foros de Amazon. Son la razón de que InvoiceGuard exista.',
    whoH: 'Para quién es',
    who: 'Para vendedores que venden a empresas en Amazon en la UE y quieren facturas completas, numeradas en orden y emitidas a tiempo, sin hacerlo a mano. Está pensado para equipos pequeños, no para asesorías.',
    howH: 'Cómo funciona',
    cards: [
      ['1. Subes tu informe de pedidos', 'Descárgalo de Seller Central y suéltalo aquí. Leemos los pedidos empresariales y omitimos el resto.'],
      ['2. Prepara y revisa la factura', 'Los datos obligatorios, la numeración y los plazos se revisan antes de que la factura sea definitiva, y el NIF del comprador se comprueba en el servicio europeo VIES. ¿Vendes en toda la UE? Las reglas del país del comprador se aplican como datos, cada una con su fuente y la fecha de su última verificación.'],
      ['3. Descargas el paquete', 'Recibes los PDF, una lista y pasos cortos para subirlas a Amazon. Todo lo que no nos encaja se queda en espera con el motivo. Nunca adivinamos.'],
    ],
    getH: 'Lo que recibes',
    get: ['Un panel sencillo: qué se facturó, qué está en espera y por qué.', 'Facturas en PDF, en el idioma del comprador cuando está soportado, y rectificativas cuando un pedido cambia.', 'NIF de compradores comprobados en el servicio europeo VIES cuando lo pides.', 'Cada factura lleva su propio registro de evidencias: el pedido detectado, la factura emitida, la subida, cada uno con su fecha y hora, para que puedas demostrar que salió dentro del plazo de Amazon.', 'Un registro inviolable de cada factura emitida.', 'Reglas por país guardadas como datos. Cada regla muestra su fuente, la fecha de verificación y un estado: verificada, secundaria o no verificada. Una regla que no podemos verificar bloquea la emisión en lugar de asumirse.'],
    notH: 'Lo que no hace',
    not: ['No da asesoramiento fiscal ni legal. Confirma tu situación con tu asesor.', 'No presenta nada ante Hacienda.', 'Algunos países están en espera hasta que leamos el texto legal oficial. La app te dice cuáles.', 'La cifra de "tasa de defectos" de la app es una estimación nuestra, no un dato de Amazon.'],
    dataH: 'Tus datos',
    data: 'Solo guardamos lo que el servicio necesita, no lo vendemos y no usamos rastreadores de publicidad ni analítica. Lee la <a href="/privacy">página de privacidad</a> para los detalles.',
    pricingH: 'Precios',
    pricing: 'InvoiceGuard es gratis durante el piloto. Todavía no hemos fijado planes de pago. Si los introducimos, los precios se mostrarán aquí antes de que nadie pague, y los usuarios del piloto lo sabrán primero.',
    pilotH: 'Piloto gratuito',
    pilot: 'Buscamos unos pocos vendedores que prueben InvoiceGuard gratis y nos digan qué falta. Visita la <a href="/contact">página de contacto</a> para escribirnos.',
    ctaSample: 'Míralo funcionar: 2 minutos, sin cuenta',
    ctaApp: 'Pruébalo tú: cuenta gratuita',
    ctaContact: 'Únete al piloto gratis',
  },
  de: {
    title: 'InvoiceGuard: B2B-Rechnungen für Amazon-Verkäufer, geprüft vor dem Versand',
    desc: 'InvoiceGuard erstellt und prüft B2B-Rechnungen für Amazon-Verkäufer in der EU. Pilotphase, ehrlich darüber, was heute funktioniert.',
    h1: 'Amazon-Business-Rechnungen, ohne den Handarbeits-Teil.',
    lead: 'Amazon sagt, die Rechnungsstellung sei automatisch. Viele Verkäufer erstellen trotzdem jede Rechnung von Hand. InvoiceGuard nimmt den Bestellbericht, den Sie aus Seller Central herunterladen, erstellt für jede Geschäftsbestellung eine Rechnung und prüft sie, bevor etwas rausgeht: die USt-IdNr. des Käufers, die Pflichtangaben, die Nummerierung, die Frist. Wenn etwas nicht passt, stoppt es und sagt Ihnen klar, was zu korrigieren ist.',
    rule: 'Deutschland: §14 UStG bestimmt, was auf jeder Rechnung stehen muss, und Amazon verlangt den Upload innerhalb eines Werktages (Amazon-Richtlinie).',
    note: '<b>Ehrlicher Stand:</b> InvoiceGuard ist ein Pilot. Es ist nicht mit Amazon verbunden. Sie laden Ihren eigenen Bestellbericht hoch und laden die fertigen Rechnungen selbst bei Amazon hoch. Die Beispieldaten in der App sind erfunden, und nichts davon wird an Amazon gesendet. Das sagen wir auf jedem Bildschirm mit Beispieldaten. Wir haben noch nicht mit einer echten Seller-Central-Datei getestet.',
    familiarH: 'Kommt Ihnen bekannt vor?',
    familiar: ['Amazons eigene Rechnungsstellung ist aktiviert, doch die Rechnungen kommen nie an, also erstellen Sie sie weiter von Hand.', 'Die eine Pan-EU-Bestellung geht mit einer Ihrer USt-IdNrn. raus, die nächste mit einer anderen, und es ist nie klar, welche auf die Rechnung gehört.', 'Ein einziges fehlendes Detail nach §14 UStG kann Ihren Käufer den Vorsteuerabzug kosten - und Sie den Käufer.'],
    familiarOut: 'Das sind die Themen, die Verkäufer in Amazons eigenen Foren posten. Genau dafür gibt es InvoiceGuard.',
    whoH: 'Für wen es ist',
    who: 'Für Verkäufer, die auf Amazon in der EU an Unternehmen verkaufen und vollständige, lückenlos nummerierte und fristgerechte Rechnungen wollen, ohne Handarbeit. Gebaut für kleine Teams, nicht für Steuerberater.',
    howH: 'So funktioniert es',
    cards: [
      ['1. Sie laden Ihren Bestellbericht hoch', 'Aus Seller Central herunterladen und hier ablegen. Wir lesen die Geschäftsbestellungen und überspringen den Rest.'],
      ['2. Es erstellt und prüft die Rechnung', 'Pflichtangaben, Nummerierung und Fristen werden geprüft, bevor die Rechnung endgültig ist, und die USt-IdNr. des Käufers wird im EU-VIES-Dienst geprüft. EU-weit unterwegs? Die Regeln des Käuferlandes werden als Daten angewendet, jede mit Quelle und Datum der letzten Prüfung.'],
      ['3. Sie laden das Paket herunter', 'Sie erhalten die PDFs, eine Liste und kurze Schritte zum Hochladen bei Amazon. Alles Unsichere wird mit Grund zurückgehalten. Wir raten nie.'],
    ],
    getH: 'Was Sie bekommen',
    get: ['Ein einfaches Dashboard: was abgerechnet wurde, was zurückgehalten ist und warum.', 'Rechnungen als PDFs, wo unterstützt in der Sprache des Käufers, und Korrekturrechnungen, wenn sich eine Bestellung ändert.', 'USt-IdNrn. von Käufern, auf Wunsch im EU-VIES-Dienst geprüft.', 'Jede Rechnung trägt ihre eigene Nachweiskette: Bestellung erkannt, Rechnung ausgestellt, Upload, jeweils mit Zeitstempel, damit du zeigen kannst, dass sie innerhalb der Amazon-Frist herausging.', 'Ein manipulationssicheres Protokoll jeder ausgestellten Rechnung.', 'Länderregeln als Daten gepflegt. Jede Regel zeigt Quelle, Prüfdatum und Status: verifiziert, sekundär oder unverifiziert. Eine Regel, die wir nicht verifizieren können, blockiert die Ausstellung, statt angenommen zu werden.'],
    notH: 'Was es nicht tut',
    not: ['Es gibt keine Steuer- oder Rechtsberatung. Bestätigen Sie Ihre Situation mit Ihrem Berater.', 'Es reicht nichts bei einer Steuerbehörde ein.', 'Einige Länder sind pausiert, bis wir den offiziellen Gesetzestext gelesen haben. Die App sagt Ihnen welche.', 'Die "Fehlerrate" in der App ist unsere eigene Schätzung, keine Amazon-Zahl.'],
    dataH: 'Ihre Daten',
    data: 'Wir speichern nur, was der Dienst braucht, verkaufen es nicht und nutzen keine Werbe- oder Analyse-Tracker. Details auf der <a href="/privacy">Datenschutzseite</a>.',
    pricingH: 'Preise',
    pricing: 'InvoiceGuard ist während der Pilotphase kostenlos. Bezahlpläne sind noch nicht festgelegt. Falls wir sie einführen, stehen die Preise hier, bevor irgendjemand zahlt, und Pilotnutzer erfahren es zuerst.',
    pilotH: 'Kostenloser Pilot',
    pilot: 'Wir suchen ein paar Verkäufer, die InvoiceGuard kostenlos testen und uns sagen, was fehlt. Über die <a href="/contact">Kontaktseite</a> erreichen Sie uns.',
    ctaSample: 'Zusehen, wie es arbeitet: 2 Minuten, kein Konto',
    ctaApp: 'Selbst testen: kostenloses Konto',
    ctaContact: 'Am kostenlosen Pilot teilnehmen',
  },
};

L.fr = {
  title: "InvoiceGuard : factures B2B pour vendeurs Amazon, vérifiées avant envoi",
  desc: "InvoiceGuard prépare et vérifie les factures B2B des vendeurs Amazon dans l'UE. Phase pilote, honnête sur ce qui fonctionne aujourd'hui.",
  h1: "Les factures Amazon Business, sans la partie manuelle.",
  lead: "Amazon dit que la facturation est automatique. Beaucoup de vendeurs continuent pourtant de faire chaque facture à la main. InvoiceGuard prend le rapport de commandes que vous téléchargez dans Seller Central, prépare une facture pour chaque commande professionnelle et la vérifie avant qu'elle ne parte : le numéro de TVA de l'acheteur, les mentions obligatoires, la numérotation, le délai. Si quelque chose cloche, il s'arrête et vous dit quoi corriger, en clair.",
  rule: "France : la facturation électronique B2B devient obligatoire par étapes à partir de 2026, et Amazon demande le téléversement sous un jour ouvré (politique d'Amazon).",
  note: "<b>Statut honnête :</b> InvoiceGuard est un pilote. Il n'est pas connecté à Amazon. Vous téléversez votre propre rapport de commandes et vous téléversez vous-même les factures finies chez Amazon. Les données d'exemple de l'app sont inventées et rien n'en est envoyé à Amazon. Nous le disons sur chaque écran qui montre des données d'exemple. Nous n'avons pas encore testé avec un vrai fichier Seller Central.",
  familiarH: "Cela vous parle ?",
  familiar: ["La facturation d'Amazon est activée, mais les factures n'arrivent jamais, alors vous continuez à les faire à la main.", "Une commande paneuropéenne part avec l'un de vos numéros de TVA, la suivante avec un autre, et on ne sait jamais lequel mettre sur la facture.", "La facturation électronique obligatoire en France entre en vigueur par étapes à partir de 2026, et personne ne dit clairement quelles factures sont concernées."],
  familiarOut: "Ce sont les discussions que les vendeurs publient sur les forums d'Amazon. C'est pour cela qu'InvoiceGuard existe.",
  whoH: "Pour qui",
  who: "Pour les vendeurs qui vendent à des entreprises sur Amazon dans l'UE et veulent des factures complètes, numérotées dans l'ordre et émises à temps, sans le faire à la main. Conçu pour les petites équipes, pas pour les experts-comptables.",
  howH: "Comment ça marche",
  cards: [
    ["1. Vous téléversez votre rapport de commandes", "Téléchargez-le dans Seller Central et déposez-le ici. Nous lisons les commandes professionnelles et ignorons le reste."],
    ["2. Il prépare et vérifie la facture", "Mentions obligatoires, numérotation et délais sont vérifiés avant que la facture soit définitive, et le numéro de TVA de l'acheteur est contrôlé dans le service européen VIES. Vous vendez dans toute l'UE ? Les règles du pays de l'acheteur sont appliquées comme des données, chacune avec sa source et la date de sa dernière vérification."],
    ["3. Vous téléchargez le paquet", "Vous recevez les PDF, une liste et de courtes étapes pour les téléverser chez Amazon. Tout ce dont nous ne sommes pas sûrs est mis en attente avec le motif. Nous ne devinons jamais."],
  ],
  getH: "Ce que vous recevez",
  get: ["Un tableau de bord simple : ce qui a été facturé, ce qui est en attente et pourquoi.", "Des factures en PDF, dans la langue de l'acheteur quand c'est pris en charge, et des factures rectificatives quand une commande change.", "Les numéros de TVA des acheteurs vérifiés dans le service européen VIES quand vous le demandez.", "Chaque facture porte sa propre piste de preuves : commande détectée, facture émise, téléversement, chacun avec son horodatage, pour prouver qu'elle est partie dans le délai d'Amazon.", "Un journal inviolable de chaque facture émise.", "Des règles par pays conservées comme données. Chaque règle montre sa source, sa date de vérification et un statut : vérifiée, secondaire ou non vérifiée. Une règle que nous ne pouvons pas vérifier bloque l'émission au lieu d'être supposée."],
  notH: "Ce que ça ne fait pas",
  not: ["Pas de conseil fiscal ou juridique. Confirmez votre situation avec votre conseiller.", "Rien n'est déposé auprès d'une administration fiscale.", "Certains pays sont en attente jusqu'à ce que nous ayons lu le texte officiel. L'app vous dit lesquels.", "Le « taux de défauts » de l'app est notre propre estimation, pas un chiffre d'Amazon."],
  dataH: "Vos données",
  data: "Nous ne gardons que ce dont le service a besoin, nous ne le vendons pas et nous n'utilisons ni traceurs publicitaires ni outils d'analyse. Lisez la <a href=\"/privacy\">page de confidentialité</a> pour les détails.",
  pricingH: "Tarifs",
  pricing: "InvoiceGuard est gratuit pendant le pilote. Les offres payantes ne sont pas encore fixées. Si nous en introduisons, les prix seront affichés ici avant que quiconque paie, et les utilisateurs du pilote seront prévenus en premier.",
  pilotH: "Pilote gratuit",
  pilot: "Nous cherchons quelques vendeurs pour essayer InvoiceGuard gratuitement et nous dire ce qui manque. Rendez-vous sur la <a href=\"/contact\">page de contact</a> pour nous écrire.",
  ctaSample: "Le voir fonctionner : 2 minutes, sans compte",
  ctaApp: "Essayez vous-même : compte gratuit",
  ctaContact: "Rejoindre le pilote gratuit",
};

L.it = {
  title: "InvoiceGuard: fatture B2B per venditori Amazon, controllate prima dell'invio",
  desc: "InvoiceGuard prepara e controlla le fatture B2B dei venditori Amazon nell'UE. Fase pilota, onesta su ciò che funziona oggi.",
  h1: "Fatture Amazon Business, senza la parte manuale.",
  lead: "Amazon dice che la fatturazione è automatica. Molti venditori continuano a fare ogni fattura a mano. InvoiceGuard prende il report degli ordini che scarichi da Seller Central, prepara una fattura per ogni ordine aziendale e la controlla prima che esca: la partita IVA dell'acquirente, i dati obbligatori, la numerazione, la scadenza. Se qualcosa non torna, si ferma e ti dice cosa correggere, in parole chiare.",
  rule: "Italia: la fatturazione elettronica tramite SDI è già in vigore, e Amazon richiede il caricamento entro un giorno lavorativo (politica di Amazon).",
  note: "<b>Stato onesto:</b> InvoiceGuard è un pilota. Non è collegato ad Amazon. Carichi il tuo report degli ordini e carichi tu stesso le fatture finite su Amazon. I dati di esempio nell'app sono inventati e niente di essi viene inviato ad Amazon. Lo diciamo in ogni schermata che mostra dati di esempio. Non abbiamo ancora testato con un file reale di Seller Central.",
  familiarH: "Ti suona familiare?",
  familiar: ["La fatturazione di Amazon è attiva, ma le fatture non arrivano mai, e continui a farle a mano.", "Un ordine Pan-EU esce con una delle tue partite IVA, il successivo con un'altra, e non è mai chiaro quale vada in fattura.", "L'Italia usa già la fatturazione elettronica via SDI, e una fattura che ignora le sue regole non è una fattura."],
  familiarOut: "Questi sono i thread che i venditori pubblicano sui forum di Amazon. Sono il motivo per cui InvoiceGuard esiste.",
  whoH: "Per chi è",
  who: "Per i venditori che vendono ad aziende su Amazon nell'UE e vogliono fatture complete, numerate in ordine ed emesse in tempo, senza farle a mano. Pensato per piccoli team, non per commercialisti.",
  howH: "Come funziona",
  cards: [
    ["1. Carichi il tuo report degli ordini", "Scaricalo da Seller Central e trascinalo qui. Leggiamo gli ordini aziendali e saltiamo il resto."],
    ["2. Prepara e controlla la fattura", "Dati obbligatori, numerazione e scadenze vengono controllati prima che la fattura sia definitiva, e la partita IVA dell'acquirente viene verificata nel servizio europeo VIES. Vendi in tutta la UE? Le regole del paese dell'acquirente sono applicate come dati, ognuna con la sua fonte e la data dell'ultima verifica."],
    ["3. Scarichi il pacchetto", "Ricevi i PDF, un elenco e pochi passi per caricarle su Amazon. Tutto ciò di cui non siamo sicuri resta in attesa con il motivo. Non tiriamo mai a indovinare."],
  ],
  getH: "Cosa ricevi",
  get: ["Una dashboard semplice: cosa è stato fatturato, cosa è in attesa e perché.", "Fatture in PDF, nella lingua dell'acquirente dove supportato, e note di credito quando un ordine cambia.", "Partite IVA degli acquirenti verificate nel servizio europeo VIES quando lo chiedi.", "Ogni fattura porta la propria traccia di evidenze: ordine rilevato, fattura emessa, caricamento, ciascuno con il suo timestamp, così puoi dimostrare che è uscita entro la finestra di Amazon.", "Un registro a prova di manomissione di ogni fattura emessa.", "Regole per paese conservate come dati. Ogni regola mostra la fonte, la data di verifica e uno stato: verificata, secondaria o non verificata. Una regola che non possiamo verificare blocca l'emissione invece di essere presunta."],
  notH: "Cosa non fa",
  not: ["Non dà consulenza fiscale o legale. Conferma la tua situazione con il tuo consulente.", "Non presenta nulla a un'amministrazione fiscale.", "Alcuni paesi sono in attesa finché non abbiamo letto il testo legale ufficiale. L'app ti dice quali.", "La cifra del \"tasso di difetti\" nell'app è una nostra stima, non un dato di Amazon."],
  dataH: "I tuoi dati",
  data: "Conserviamo solo ciò che serve al servizio, non lo vendiamo e non usiamo tracker pubblicitari o di analisi. Leggi la <a href=\"/privacy\">pagina sulla privacy</a> per i dettagli.",
  pricingH: "Prezzi",
  pricing: "InvoiceGuard è gratuito durante il pilota. I piani a pagamento non sono ancora definiti. Se li introdurremo, i prezzi saranno mostrati qui prima che chiunque paghi, e gli utenti del pilota lo sapranno per primi.",
  pilotH: "Pilota gratuito",
  pilot: "Cerchiamo alcuni venditori che provino InvoiceGuard gratis e ci dicano cosa manca. Vai alla <a href=\"/contact\">pagina dei contatti</a> per scriverci.",
  ctaSample: "Guardalo al lavoro: 2 minuti, senza account",
  ctaApp: "Provalo tu: account gratuito",
  ctaContact: "Unisciti al pilota gratuito",
};

L.nl = {
  title: "InvoiceGuard: B2B-facturen voor Amazon-verkopers, gecontroleerd voor verzending",
  desc: "InvoiceGuard maakt en controleert B2B-facturen voor Amazon-verkopers in de EU. Pilootfase, eerlijk over wat vandaag werkt.",
  h1: "Amazon Business-facturen, zonder het handwerk.",
  lead: "Amazon zegt dat facturatie automatisch is. Toch maken veel verkopers elke factuur met de hand. InvoiceGuard neemt het bestelrapport dat je uit Seller Central downloadt, maakt voor elke zakelijke bestelling een factuur en controleert die voordat er iets uitgaat: het btw-nummer van de koper, de verplichte gegevens, de nummering, de deadline. Klopt er iets niet, dan stopt het en zegt het in heldere taal wat je moet herstellen.",
  rule: "Nederland: Amazon vraagt de factuur binnen één werkdag na verzending (Amazon-beleid); de wettelijke deadline is de 15e van de volgende maand.",
  note: "<b>Eerlijke status:</b> InvoiceGuard is een piloot. Het is niet met Amazon verbonden. Je uploadt je eigen bestelrapport en je uploadt de klaar gemaakte facturen zelf bij Amazon. De voorbeeldgegevens in de app zijn verzonnen en er wordt niets daarvan naar Amazon gestuurd. Dat zeggen we op elk scherm met voorbeeldgegevens. We hebben nog niet met een echt Seller Central-bestand getest.",
  familiarH: "Herkenbaar?",
  familiar: ["De facturatie van Amazon staat aan, maar de facturen komen nooit, dus je blijft ze met de hand maken.", "De ene Pan-EU-bestelling gaat met het ene btw-nummer van je de deur uit, de volgende met een ander, en het is nooit duidelijk welke op de factuur hoort.", "De wettelijke deadline is de 15e van volgende maand, maar Amazon wil het morgen - en de koper merkt het gat eerder dan de fiscus."],
  familiarOut: "Dit zijn de discussies die verkopers op Amazons eigen forums plaatsen. Daarom bestaat InvoiceGuard.",
  whoH: "Voor wie het is",
  who: "Voor verkopers die op Amazon in de EU aan bedrijven verkopen en complete, op volgorde genummerde en tijdige facturen willen, zonder handwerk. Gebouwd voor kleine teams, niet voor accountants.",
  howH: "Zo werkt het",
  cards: [
    ["1. Je uploadt je bestelrapport", "Download het uit Seller Central en sleep het hierin. Wij lezen de zakelijke bestellingen en slaan de rest over."],
    ["2. Het maakt en controleert de factuur", "Verplichte gegevens, nummering en deadlines worden gecontroleerd voordat de factuur definitief is, en het btw-nummer van de koper wordt nagekeken in de Europese VIES-dienst. Verkoop je EU-breed? De regels van het land van de koper worden als data toegepast, elk met bron en datum van de laatste controle."],
    ["3. Je downloadt het pakket", "Je krijgt de pdf's, een lijst en korte stappen om ze bij Amazon te uploaden. Alles waar we niet zeker van zijn wordt met reden aangehouden. We gokken nooit."],
  ],
  getH: "Wat je krijgt",
  get: ["Een eenvoudig dashboard: wat is gefactureerd, wat is aangehouden en waarom.", "Facturen als pdf, waar ondersteund in de taal van de koper, en creditnota's als een bestelling verandert.", "Btw-nummers van kopers op verzoek gecontroleerd in de Europese VIES-dienst.", "Elke factuur draagt zijn eigen bewijsspoor: bestelling gedetecteerd, factuur uitgereikt, upload, elk met een tijdstempel, zodat je kunt laten zien dat hij binnen de termijn van Amazon is verstuurd.", "Een fraudebestendig logboek van elke uitgereikte factuur.", "Landelijke regels als data bijgehouden. Elke regel toont bron, controledatum en status: geverifieerd, secundair of ongeverifieerd. Een regel die we niet kunnen verifiëren blokkeert het uitreiken in plaats van aangenomen te worden."],
  notH: "Wat het niet doet",
  not: ["Het geeft geen fiscaal of juridisch advies. Bevestig je eigen situatie met je adviseur.", "Het dient niets in bij een belastingdienst.", "Sommige landen staan on hold tot we de officiële wettekst hebben gelezen. De app vertelt je welke.", "Het 'defectenpercentage' in de app is onze eigen schatting, geen Amazon-cijfer."],
  dataH: "Je gegevens",
  data: "We bewaren alleen wat de dienst nodig heeft, verkopen het niet en gebruiken geen advertentie- of analytische trackers. Lees de <a href=\"/privacy\">privacypagina</a> voor de details.",
  pricingH: "Prijzen",
  pricing: "InvoiceGuard is gratis tijdens de piloot. Betaalde plannen zijn nog niet vastgesteld. Als we die invoeren, staan de prijzen hier voordat iemand betaalt, en horen pilootgebruikers het als eerste.",
  pilotH: "Gratis piloot",
  pilot: "We zoeken een paar verkopers die InvoiceGuard gratis proberen en ons vertellen wat er mist. Kijk op de <a href=\"/contact\">contactpagina</a> om ons te bereiken.",
  ctaSample: "Zie het werken: 2 minuten, geen account",
  ctaApp: "Probeer zelf: gratis account",
  ctaContact: "Doe mee aan de gratis piloot",
};

L.pl = {
  title: "InvoiceGuard: faktury B2B dla sprzedawców Amazon, sprawdzone przed wysyłką",
  desc: "InvoiceGuard przygotowuje i sprawdza faktury B2B sprzedawców Amazon w UE. Faza pilotażowa, szczera o tym, co działa już dziś.",
  h1: "Faktury Amazon Business bez ręcznej roboty.",
  lead: "Amazon mówi, że fakturowanie jest automatyczne. Wielu sprzedawców nadal robi każdą fakturę ręcznie. InvoiceGuard bierze raport zamówień pobrany z Seller Central, przygotowuje fakturę dla każdego zamówienia firmowego i sprawdza ją, zanim cokolwiek wyjdzie: numer VAT kupującego, wymagane dane, numeracja, termin. Jeśli coś się nie zgadza, zatrzymuje się i jasnym językiem mówi, co poprawić.",
  rule: "Polska: Amazon wymaga faktury w ciągu jednego dnia roboczego od wysyłki (polityka Amazona), a KSeF obowiązuje już część podatników z polską siedzibą.",
  note: "<b>Szczery status:</b> InvoiceGuard to pilotaż. Nie jest połączony z Amazonem. Wgrywasz własny raport zamówień i sam wgrywasz gotowe faktury do Amazona. Przykładowe dane w aplikacji są zmyślone i nic z nich nie jest wysyłane do Amazona. Mówimy to na każdym ekranie z przykładowymi danymi. Nie testowaliśmy jeszcze na prawdziwym pliku z Seller Central.",
  familiarH: "Brzmi znajomo?",
  familiar: ["Fakturowanie Amazona jest włączone, a faktury nie przychodzą, więc nadal robisz je ręcznie.", "Jedno zamówienie Pan-EU wychodzi z jednym Twoim numerem VAT, następne z innym, i nigdy nie wiadomo, który trafić ma na fakturę.", "KSeF już działa dla części sprzedawców, a jak łączy się z przesyłaniem faktur do Amazona, nie wyjaśnia nikt wprost."],
  familiarOut: "To wątki, które sprzedawcy zakładają na forach Amazona. Po to powstał InvoiceGuard.",
  whoH: "Dla kogo",
  who: "Dla sprzedawców, którzy sprzedają firmom na Amazonie w UE i chcą kompletnych, kolejno numerowanych i terminowych faktur bez ręcznej roboty. Zbudowane dla małych zespołów, nie dla księgowych.",
  howH: "Jak to działa",
  cards: [
    ["1. Wgrywasz raport zamówień", "Pobierz go z Seller Central i upuść tutaj. Czytamy zamówienia firmowe i pomijamy resztę."],
    ["2. Przygotowuje i sprawdza fakturę", "Wymagane dane, numeracja i terminy są sprawdzane, zanim faktura stanie się ostateczna, a numer VAT kupującego jest weryfikowany w europejskim serwisie VIES. Sprzedajesz w całej UE? Zasady kraju kupującego stosowane są jako dane, każda ze źródłem i datą ostatniej weryfikacji."],
    ["3. Pobierasz pakiet", "Dostajesz pliki PDF, listę i krótkie kroki do wgrania ich do Amazona. Wszystko, czego nie jesteśmy pewni, czeka z podanym powodem. Nigdy nie zgadujemy."],
  ],
  getH: "Co dostajesz",
  get: ["Prosty panel: co zafakturowano, co czeka i dlaczego.", "Faktury jako PDF, tam gdzie obsługiwane w języku kupującego, oraz faktury korygujące, gdy zamówienie się zmieni.", "Numery VAT kupujących sprawdzane w europejskim serwisie VIES na życzenie.", "Każda faktura ma własny ślad dowodowy: zamówienie wykryte, faktura wystawiona, wysyłka, każde ze znacznikiem czasu, więc możesz pokazać, że wyszła w terminie Amazon.", "Odporny na manipulacje dziennik każdej wystawionej faktury.", "Zasady krajowe przechowywane jako dane. Każda zasada pokazuje źródło, datę weryfikacji i status: zweryfikowana, wtórna lub niezweryfikowana. Zasada, której nie możemy zweryfikować, blokuje wystawienie zamiast być założoną."],
  notH: "Czego nie robi",
  not: ["Nie udziela porad podatkowych ani prawnych. Potwierdź swoją sytuację z doradcą.", "Nie składa niczego w urzędzie skarbowym.", "Niektóre kraje czekają, aż przeczytamy oficjalny tekst prawny. Aplikacja mówi które.", "Liczba 'wskaźnik błędów' w aplikacji to nasze własne oszacowanie, nie dane Amazona."],
  dataH: "Twoje dane",
  data: "Przechowujemy tylko to, czego usługa potrzebuje, nie sprzedajemy tego i nie używamy trackerów reklamowych ani analitycznych. Szczegóły na <a href=\"/privacy\">stronie prywatności</a>.",
  pricingH: "Ceny",
  pricing: "InvoiceGuard jest darmowy w pilotażu. Planów płatnych jeszcze nie ustalono. Jeśli je wprowadzimy, ceny pojawią się tutaj, zanim ktokolwiek zapłaci, a użytkownicy pilotaża dowiedzą się pierwsi.",
  pilotH: "Darmowy pilotaż",
  pilot: "Szukamy kilku sprzedawców, którzy za darmo wypróbują InvoiceGuard i powiedzą nam, czego brakuje. Napisz przez <a href=\"/contact\">stronę kontaktu</a>.",
  ctaSample: "Zobacz jak działa: 2 minuty, bez konta",
  ctaApp: "Spróbuj sam: darmowe konto",
  ctaContact: "Dołącz do darmowego pilotażu",
};

export function landingLocalized(lang) {
  const s = L[lang];
  if (!s) return null;
  return pageLoc(s.title, `
<section class="hero"><h1>${s.h1}</h1>
<p class="lead">${s.lead}</p>
<p class="mut" style="margin-top:-4px">${esc(s.rule)}</p>
<p><a class="btn" href="/sample">${esc(s.ctaSample)}</a> &nbsp; <a class="btn alt" href="/app">${esc(s.ctaApp)}</a> &nbsp; <a class="btn alt" href="/contact">${esc(s.ctaContact)}</a></p></section>
<div class="note">${s.note}</div>
<h2>${esc(s.familiarH)}</h2><ul>${s.familiar.map(f => '<li>' + esc(f) + '</li>').join('')}</ul>
<p>${esc(s.familiarOut)}</p>
<h2>${esc(s.whoH)}</h2><p>${esc(s.who)}</p>
<h2 id="how">${esc(s.howH)}</h2>
<div class="grid">${s.cards.map(([h, p]) => `<div class="card"><h3>${esc(h)}</h3><p>${esc(p)}</p></div>`).join('')}</div>
<h2>${esc(s.getH)}</h2><ul>${s.get.map(x => '<li>' + esc(x) + '</li>').join('')}</ul>
<h2>${esc(s.notH)}</h2><ul>${s.not.map(x => '<li>' + esc(x) + '</li>').join('')}</ul>
<h2>${esc(s.dataH)}</h2><p>${s.data}</p>
<h2 id="pricing">${esc(s.pricingH)}</h2><p>${esc(s.pricing)}</p>
<h2>${esc(s.pilotH)}</h2><p>${s.pilot}</p>
<p style="margin-top:26px"><a class="btn" href="/sample">${esc(s.ctaSample)}</a> &nbsp; <a class="btn alt" href="/contact">${esc(s.ctaContact)}</a></p>`, s.desc, L, lang);
}

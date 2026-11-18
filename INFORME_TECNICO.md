# Informe Técnico de Arquitectura y Funcionamiento
## Sistema Diario Inteligente (Local-First · Windows Native)

Consulta el documento maestro interactivo generado en los artefactos del sistema o este archivo en el repositorio.

**Versión:** 1.0.0-rc  
**Fecha de emisión:** Noviembre 2026  
**Stack tecnológico:** Python 3.12 (FastAPI + Uvicorn) · SQLite (WAL) · Laya AI (ModernBERT 322M) · Ollama (Qwen 3.5:4b) · Vanilla JS (Apple HIG UI)

---

## 1. Resumen Ejecutivo y Filosofía del Sistema

El **Diario Inteligente** es una plataforma de captura reflexiva y seguimiento emocional que opera bajo el paradigma **100% Local-First / Zero-Cloud**. Toda la información (textos, horas de sueño, auto-reportes, probabilidades afectivas) se procesa y almacena localmente en la máquina del usuario, garantizando privacidad absoluta y latencias predecibles sin dependencia de servicios externos.

### Principios Rectores de Diseño:
1. **Decisions, not text (Laya AI):** La clasificación de emociones y temáticas no se delega a un Modelo de Lenguaje de Gran Escala (LLM) autorregresivo generador de texto, sino a un clasificador discriminativo paralelo (**Laya**) que produce directamente distribuciones de probabilidad calibradas sobre preguntas tipadas (`choice`, `score`, `noul`).
2. **Cero aritmética con LLMs:** Todos los cálculos matemáticos (promedios de valencia, horas de sueño efectivas con cruce de medianoche, rachas, líneas base y discrepancias cognitivas) se calculan en **Python puro**, garantizando consistencia determinista y trazabilidad auditable.
3. **Redacción asistida no patologizante (Qwen 3.5):** El LLM secundario nunca lee los textos crudos del usuario; únicamente recibe perfiles numéricos JSON procesados por Laya y resúmenes estadísticos de Python, redactando observaciones con lenguaje estrictamente no clínico (*"señal"*, *"patrón"*, *"sugerencia"*).
4. **Desacoplamiento arquitectónico para el futuro:** La persistencia se encuentra encapsulada en una interfaz abstracta (`BaseDiaryRepository`), permitiendo envolver la aplicación en un contenedor de escritorio **Electron** o habilitar sincronización con **Firebase/Firestore** sin modificar la lógica del negocio.

---

## 2. Puntos Clave de Funcionamiento

### 2.1 Motor Laya AI y Cálculo de Valencia Continua
Laya evalúa la batería de preguntas en paralelo en una sola pasada forward pass (~33 ms en GPU / ~1.2 s en CPU).
La valencia continua (1.0 a 5.0) para las gráficas temporales se calcula como el valor esperado de la distribución:
$$\text{Valencia}_{\text{estimada}} = \sum_{i \in \mathcal{C}} P(c_i) \cdot V(c_i)$$
Donde $V \in \{1.0, 2.0, 3.0, 4.0, 5.0\}$ para cada nivel desde `muy_negativo` hasta `muy_positivo`.

### 2.2 Cruce del Cuestionario Diario y Discrepancias
- **Horas de sueño:** Calculadas deterministamente con $t_{\text{despertar}} - t_{\text{acostar}}$ corrigiendo cruce de medianoche.
- **Detector de Discrepancia:** Alerta serena si el auto-reporte en una palabra es "Bien" pero $P(\text{muy\_negativo}) + P(\text{negativo}) \ge 0.65$, o si es "Mal" con $P(\text{positivo}) \ge 0.70$.
- **Capa de Seguridad (2 niveles):** Regex determinista para autolesión/purga + semántico para $P(\text{desgaste\_sostenido}) \ge 0.88$ con líneas de ayuda oficiales.

### 2.3 Guía de Archivos para tus Ajustes

- **Ajustar preguntas o temas de Laya:** [backend/services/laya_engine.py](backend/services/laya_engine.py)
- **Calibrar umbrales de discrepancia o fórmulas:** [backend/services/analytics.py](backend/services/analytics.py)
- **Filtros de seguridad y líneas telefónicas:** [backend/services/safety.py](backend/services/safety.py)
- **Prompt y vocabulario del redactor:** [backend/services/qwen_engine.py](backend/services/qwen_engine.py)
- **Arranque rápido y parada:** `run.bat` / `start_app.ps1` y `stop_app.bat`

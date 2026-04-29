"""Generate Q9 appendix: architecture diagram + validation/benchmark matrix."""

from fpdf import FPDF


class AppendixPDF(FPDF):
    def header(self):
        self.set_font("Helvetica", "B", 9)
        self.cell(0, 5, "Hippo: Biologically-Inspired Memory Architecture for Foundation Model Agents", align="C")
        self.ln(6)

    def footer(self):
        self.set_y(-12)
        self.set_font("Helvetica", "I", 7)
        self.cell(0, 10, f"KITFUNSO LTD | Frontier AI Discovery | Page {self.page_no()}/2", align="C")


def draw_box(pdf: FPDF, x: float, y: float, w: float, h: float,
             label: str, fill_r: int, fill_g: int, fill_b: int,
             sublabel: str = "") -> None:
    pdf.set_fill_color(fill_r, fill_g, fill_b)
    pdf.set_draw_color(60, 60, 60)
    pdf.rect(x, y, w, h, "FD")
    pdf.set_xy(x, y + 2)
    pdf.set_font("Helvetica", "B", 7)
    pdf.set_text_color(255, 255, 255)
    pdf.cell(w, 4, label, align="C")
    if sublabel:
        pdf.set_xy(x, y + 6)
        pdf.set_font("Helvetica", "", 5.5)
        pdf.cell(w, 3, sublabel, align="C")
    pdf.set_text_color(0, 0, 0)


def draw_arrow_down(pdf: FPDF, x: float, y_start: float, y_end: float) -> None:
    pdf.set_draw_color(80, 80, 80)
    pdf.line(x, y_start, x, y_end)
    pdf.line(x, y_end, x - 2, y_end - 3)
    pdf.line(x, y_end, x + 2, y_end - 3)


def draw_arrow_right(pdf: FPDF, x_start: float, x_end: float, y: float) -> None:
    pdf.set_draw_color(80, 80, 80)
    pdf.line(x_start, y, x_end, y)
    pdf.line(x_end, y, x_end - 3, y - 2)
    pdf.line(x_end, y, x_end - 3, y + 2)


def draw_arrow_left(pdf: FPDF, x_start: float, x_end: float, y: float) -> None:
    pdf.set_draw_color(80, 80, 80)
    pdf.line(x_start, y, x_end, y)
    pdf.line(x_end, y, x_end + 3, y - 2)
    pdf.line(x_end, y, x_end + 3, y + 2)


def generate() -> None:
    pdf = AppendixPDF(orientation="P", format="A4")
    pdf.set_auto_page_break(auto=False)

    # === PAGE 1: SYSTEM ARCHITECTURE ===
    pdf.add_page()

    pdf.set_font("Helvetica", "B", 12)
    pdf.cell(0, 7, "Page 1: System Architecture", new_x="LMARGIN", new_y="NEXT")
    pdf.ln(2)

    # Layer 1: Agent / Foundation Model Layer
    pdf.set_font("Helvetica", "B", 8)
    pdf.set_text_color(100, 100, 100)
    pdf.cell(0, 5, "AGENT LAYER", new_x="LMARGIN", new_y="NEXT")
    pdf.set_text_color(0, 0, 0)

    y_agents = pdf.get_y()
    agent_colors = (41, 128, 185)
    draw_box(pdf, 15, y_agents, 38, 14, "LangChain", *agent_colors, "Agent Framework")
    draw_box(pdf, 58, y_agents, 38, 14, "AutoGen", *agent_colors, "Agent Framework")
    draw_box(pdf, 101, y_agents, 38, 14, "CrewAI", *agent_colors, "Agent Framework")
    draw_box(pdf, 144, y_agents, 50, 14, "Custom Agents", *agent_colors, "Any LLM Platform")

    # Arrows down to API layer
    for x in [34, 77, 120, 169]:
        draw_arrow_down(pdf, x, y_agents + 14, y_agents + 20)

    # Layer 2: Hippo API
    y_api = y_agents + 21
    draw_box(pdf, 15, y_api, 179, 14, "Hippo API Layer", 44, 62, 80, "store() | query() | consolidate() | forget() | replay() | evaluate()")

    # Arrow down
    draw_arrow_down(pdf, 104, y_api + 14, y_api + 20)

    # Layer 3: Core Engine (main box)
    y_core = y_api + 21
    pdf.set_font("Helvetica", "B", 8)
    pdf.set_text_color(100, 100, 100)
    pdf.set_xy(15, y_core - 5)
    pdf.cell(0, 5, "HIPPO CORE ENGINE", new_x="LMARGIN", new_y="NEXT")
    pdf.set_text_color(0, 0, 0)

    # Outer box for core
    pdf.set_fill_color(240, 240, 245)
    pdf.set_draw_color(60, 60, 60)
    pdf.rect(15, y_core, 179, 62, "FD")

    # 7 hippocampal mechanisms
    mech_colors = (142, 68, 173)
    mech_y = y_core + 4
    mechs = [
        ("Encoding", "Text to 384d"),
        ("Consolidation", "Merge clusters"),
        ("Decay", "Temporal fade"),
        ("Replay", "Sleep-like reorg"),
    ]
    mech_w = 40
    for i, (name, sub) in enumerate(mechs):
        x = 20 + i * 43
        draw_box(pdf, x, mech_y, mech_w, 12, name, *mech_colors, sub)

    mechs2 = [
        ("Pattern Complete", "Partial recall"),
        ("Interference", "Conflict separate"),
        ("Emotional Tag", "Salience weight"),
    ]
    mech_y2 = mech_y + 16
    for i, (name, sub) in enumerate(mechs2):
        x = 20 + i * 55
        draw_box(pdf, x, mech_y2, 50, 12, name, *mech_colors, sub)

    # Physics engine box
    phys_y = mech_y2 + 16
    draw_box(pdf, 20, phys_y, 80, 14, "Velocity Verlet Integrator", 39, 174, 96, "384-dim embedding space | Force calibration")

    # Eval harness box
    draw_box(pdf, 110, phys_y, 78, 14, "Evaluation Harness", 230, 126, 34, "MRR | NDCG | Recall@k | Latency")

    # Arrow between physics and eval
    draw_arrow_right(pdf, 100, 110, phys_y + 7)

    # Particle visualisation label
    pdf.set_font("Helvetica", "I", 6)
    pdf.set_xy(20, phys_y + 15)
    pdf.cell(80, 4, "Memories as particles with attraction/repulsion/decay forces", align="C")

    # Layer 4: Storage
    y_storage = y_core + 66
    pdf.set_font("Helvetica", "B", 8)
    pdf.set_text_color(100, 100, 100)
    pdf.set_xy(15, y_storage)
    pdf.cell(0, 5, "PERSISTENCE LAYER", new_x="LMARGIN", new_y="NEXT")
    pdf.set_text_color(0, 0, 0)

    y_st = y_storage + 6
    store_colors = (52, 73, 94)
    draw_box(pdf, 15, y_st, 55, 12, "File System", *store_colors, "JSON / MessagePack")
    draw_box(pdf, 78, y_st, 55, 12, "SQLite / PostgreSQL", *store_colors, "Structured storage")
    draw_box(pdf, 141, y_st, 53, 12, "In-Memory", *store_colors, "Fast ephemeral")

    # Arrows up from storage to core
    for x in [42, 105, 167]:
        draw_arrow_down(pdf, x, y_core + 62, y_st)

    # Key stats box
    y_stats = y_st + 18
    pdf.set_fill_color(245, 245, 245)
    pdf.rect(15, y_stats, 179, 16, "FD")
    pdf.set_font("Helvetica", "B", 8)
    pdf.set_xy(15, y_stats + 1)
    pdf.cell(179, 5, "Current System Status (v0.27.0)", align="C")
    pdf.set_font("Helvetica", "", 7)
    stats = [
        "28 source modules", "527 passing tests", "6 platform integrations",
        "384-dim embeddings", "7 hippocampal mechanisms", "MIT + proprietary extensions"
    ]
    pdf.set_xy(15, y_stats + 7)
    pdf.cell(179, 4, "  |  ".join(stats), align="C")

    # Phase 2 vision box
    y_phase2 = y_stats + 20
    pdf.set_fill_color(231, 76, 60)
    pdf.rect(15, y_phase2, 179, 14, "FD")
    pdf.set_font("Helvetica", "B", 8)
    pdf.set_text_color(255, 255, 255)
    pdf.set_xy(15, y_phase2 + 1)
    pdf.cell(179, 5, "Phase 2 Vision: Multi-Agent Shared Memory", align="C")
    pdf.set_font("Helvetica", "", 7)
    pdf.set_xy(15, y_phase2 + 7)
    pdf.cell(179, 4, "Multiple foundation model agents contributing to a collective particle space with emergent knowledge structures", align="C")
    pdf.set_text_color(0, 0, 0)

    # === PAGE 2: VALIDATION & BENCHMARK MATRIX ===
    pdf.add_page()

    pdf.set_font("Helvetica", "B", 12)
    pdf.cell(0, 7, "Page 2: Validation and Benchmark Matrix", new_x="LMARGIN", new_y="NEXT")
    pdf.ln(3)

    # Section A: Benchmark comparison matrix
    pdf.set_font("Helvetica", "B", 10)
    pdf.cell(0, 6, "A. Benchmark Comparison Matrix", new_x="LMARGIN", new_y="NEXT")
    pdf.ln(2)

    # Table header
    col_widths = [40, 28, 28, 28, 28, 38]
    headers = ["Metric", "Hippo", "FAISS", "ChromaDB", "LlamaIndex", "Success Criterion"]

    pdf.set_font("Helvetica", "B", 7)
    pdf.set_fill_color(0, 51, 102)
    pdf.set_text_color(255, 255, 255)
    for i, h in enumerate(headers):
        pdf.cell(col_widths[i], 7, h, border=1, fill=True, align="C")
    pdf.ln()

    pdf.set_text_color(0, 0, 0)
    pdf.set_font("Helvetica", "", 7)

    rows = [
        ["MRR (1K entries)", "Measured", "Measured", "Measured", "Measured", "> 0.70"],
        ["MRR (10K entries)", "Measured", "Measured", "Measured", "Measured", "> 0.70"],
        ["MRR (50K entries)", "Measured", "Measured", "Measured", "Measured", "> 0.70"],
        ["MRR (100K entries)", "Measured", "Measured", "Measured", "Measured", "> 0.70"],
        ["NDCG@10 (1K)", "Measured", "Measured", "Measured", "Measured", "> 0.75"],
        ["NDCG@10 (100K)", "Measured", "Measured", "Measured", "Measured", "> 0.75"],
        ["Recall@5 (100K)", "Measured", "Measured", "Measured", "Measured", "> 0.80"],
        ["Recall@20 (100K)", "Measured", "Measured", "Measured", "Measured", "> 0.90"],
        ["Retrieval latency (1K)", "Measured", "Measured", "Measured", "Measured", "< 50ms"],
        ["Retrieval latency (100K)", "Measured", "Measured", "Measured", "Measured", "< 500ms"],
        ["Precision after 30 days", "Measured", "Measured", "Measured", "Measured", "< 5% degradation"],
        ["Memory consolidation", "Yes", "No", "No", "No", "Unique capability"],
        ["Graceful forgetting", "Yes", "No", "No", "No", "Unique capability"],
        ["Sleep-like replay", "Yes", "No", "No", "No", "Unique capability"],
    ]

    for row_idx, row in enumerate(rows):
        if row_idx % 2 == 0:
            pdf.set_fill_color(240, 240, 245)
        else:
            pdf.set_fill_color(255, 255, 255)
        for i, cell in enumerate(row):
            style = "B" if i == 0 or (i == 1 and cell == "Yes") else ""
            pdf.set_font("Helvetica", style, 7)
            if cell == "Yes":
                pdf.set_text_color(39, 174, 96)
            elif cell == "No":
                pdf.set_text_color(231, 76, 60)
            else:
                pdf.set_text_color(0, 0, 0)
            pdf.cell(col_widths[i], 6, cell, border=1, fill=True, align="C")
        pdf.ln()

    pdf.set_text_color(0, 0, 0)

    # Section B: Validation Plan Matrix
    pdf.ln(4)
    pdf.set_font("Helvetica", "B", 10)
    pdf.cell(0, 6, "B. Validation Plan Matrix", new_x="LMARGIN", new_y="NEXT")
    pdf.ln(2)

    val_cols = [14, 52, 42, 42, 42]
    val_headers = ["Obj.", "What We Validate", "Method", "Success Criterion", "Deliverable"]

    pdf.set_font("Helvetica", "B", 7)
    pdf.set_fill_color(0, 51, 102)
    pdf.set_text_color(255, 255, 255)
    for i, h in enumerate(val_headers):
        pdf.cell(val_cols[i], 7, h, border=1, fill=True, align="C")
    pdf.ln()

    pdf.set_text_color(0, 0, 0)
    pdf.set_font("Helvetica", "", 6.5)

    val_rows = [
        ["O1", "Convergence of particle\ndynamics under load",
         "Lyapunov stability analysis\n+ 100hr empirical tests",
         "Bounded energy;\nconvergence in all 10\nworkload profiles",
         "Convergence proof\ndocument"],
        ["O2", "Retrieval quality vs\nstate-of-the-art RAG",
         "Paired benchmarks vs\nFAISS, ChromaDB,\nLlamaIndex (30 runs each)",
         "MRR > 0.70, NDCG > 0.75\nat 100K entries;\n< 5% precision degradation",
         "Benchmark report\nwith statistical analysis"],
        ["O3", "Multi-agent shared\nmemory feasibility",
         "Architecture analysis;\nconflict resolution\nsimulation",
         "Specification complete;\n2+ enterprise partners\nengaged",
         "Phase 2 technical\nspecification"],
    ]

    for row in val_rows:
        max_lines = max(len(cell.split("\n")) for cell in row)
        row_h = max_lines * 4
        y_before = pdf.get_y()
        for i, cell in enumerate(row):
            x_before = pdf.get_x()
            lines = cell.split("\n")
            pdf.rect(x_before, y_before, val_cols[i], row_h)
            for j, line in enumerate(lines):
                pdf.set_xy(x_before + 1, y_before + j * 4 + 1)
                pdf.cell(val_cols[i] - 2, 3.5, line)
            pdf.set_xy(x_before + val_cols[i], y_before)
        pdf.set_xy(15, y_before + row_h)

    # Section C: Timeline
    pdf.ln(4)
    pdf.set_font("Helvetica", "B", 10)
    pdf.cell(0, 6, "C. Feasibility Study Timeline", new_x="LMARGIN", new_y="NEXT")
    pdf.ln(2)

    time_cols = [30, 55, 55, 52]
    time_headers = ["Phase", "Month 1 (Oct 2026)", "Month 2 (Nov 2026)", "Month 3 (Dec 2026)"]

    pdf.set_font("Helvetica", "B", 7)
    pdf.set_fill_color(0, 51, 102)
    pdf.set_text_color(255, 255, 255)
    for i, h in enumerate(time_headers):
        pdf.cell(time_cols[i], 7, h, border=1, fill=True, align="C")
    pdf.ln()

    pdf.set_text_color(0, 0, 0)

    time_rows = [
        ("O1: Convergence", (142, 68, 173), [True, False, False]),
        ("O2: Benchmarks", (41, 128, 185), [False, True, False]),
        ("O3: Multi-agent spec", (39, 174, 96), [False, False, True]),
        ("Reporting", (52, 73, 94), [False, False, True]),
        ("Partner engagement", (230, 126, 34), [True, True, True]),
    ]

    pdf.set_font("Helvetica", "", 7)
    for label, (r, g, b), months in time_rows:
        pdf.cell(time_cols[0], 7, label, border=1, align="C")
        for i, active in enumerate(months):
            if active:
                pdf.set_fill_color(r, g, b)
                pdf.cell(time_cols[i + 1], 7, "", border=1, fill=True)
            else:
                pdf.cell(time_cols[i + 1], 7, "", border=1)
        pdf.ln()

    pdf.output("C:/Users/skf_s/hippo/frontier-ai-application/q9_architecture_benchmarks.pdf")
    print("Q9 appendix saved.")


if __name__ == "__main__":
    generate()

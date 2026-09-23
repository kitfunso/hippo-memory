"""Generate Q10 appendix: team summary."""

from fpdf import FPDF


class AppendixPDF(FPDF):
    def header(self):
        self.set_font("Helvetica", "B", 9)
        self.cell(0, 5, "Hippo: Biologically-Inspired Memory Architecture for Foundation Model Agents", align="C")
        self.ln(6)

    def footer(self):
        self.set_y(-12)
        self.set_font("Helvetica", "I", 7)
        self.cell(0, 10, f"KITFUNSO LTD | Frontier AI Discovery | Page {self.page_no()}/1", align="C")


def generate() -> None:
    pdf = AppendixPDF(orientation="P", format="A4")
    pdf.add_page()
    pdf.set_auto_page_break(auto=True, margin=20)

    pdf.set_font("Helvetica", "B", 14)
    pdf.cell(0, 8, "Team Summary", new_x="LMARGIN", new_y="NEXT")
    pdf.ln(3)

    # Principal Researcher section
    pdf.set_fill_color(0, 51, 102)
    pdf.set_text_color(255, 255, 255)
    pdf.set_font("Helvetica", "B", 11)
    pdf.cell(0, 8, "  Keith So - Principal Researcher and Lead Engineer", fill=True, new_x="LMARGIN", new_y="NEXT")
    pdf.set_text_color(0, 0, 0)
    pdf.ln(3)

    # Info table
    info = [
        ("Organisation", "KITFUNSO LTD (UK registered)"),
        ("Role", "Principal Researcher, sole developer"),
        ("FTE commitment", "80% for 3 months (Oct - Dec 2026)"),
        ("Location", "London, United Kingdom"),
    ]

    pdf.set_font("Helvetica", "", 9)
    for label, value in info:
        pdf.set_font("Helvetica", "B", 9)
        pdf.cell(40, 6, label + ":")
        pdf.set_font("Helvetica", "", 9)
        pdf.cell(0, 6, value, new_x="LMARGIN", new_y="NEXT")

    pdf.ln(3)

    # Relevant experience
    pdf.set_font("Helvetica", "B", 10)
    pdf.set_fill_color(240, 240, 245)
    pdf.cell(0, 7, "  Relevant Experience", fill=True, new_x="LMARGIN", new_y="NEXT")
    pdf.ln(2)

    pdf.set_font("Helvetica", "", 9)
    experiences = [
        "Hippo Memory System (2024-present): Designed and built the entire Hippo system from concept "
        "through 27 release versions. Implemented 7 biologically-inspired memory mechanisms, a Velocity "
        "Verlet physics engine for 384-dimensional particle dynamics, a quantitative evaluation harness "
        "(MRR/NDCG metrics), and integrations with 6 major AI platforms. 28 source modules, 527 automated "
        "tests. Published on npm as open-source.",

        "Quantitative Trading Systems: Multi-year experience designing and operating production algorithmic "
        "trading infrastructure. Built real-time signal generation pipelines, risk management systems, and "
        "automated execution platforms handling live financial markets. Directly relevant skills: numerical "
        "methods, statistical analysis, high-dimensional optimisation, and system reliability under "
        "production constraints.",

        "Production AI Tooling: Built and maintained AI-powered data extraction and analysis systems "
        "processing large-scale unstructured data. Experience with LLM integration, prompt engineering, "
        "evaluation methodology, and deploying AI systems in production environments with reliability "
        "and accuracy requirements.",
    ]

    for exp in experiences:
        pdf.set_font("Helvetica", "B", 9)
        title_end = exp.index(":")
        pdf.cell(3, 5, "-")
        pdf.set_font("Helvetica", "B", 9)
        # Write title part
        title = exp[:title_end + 1]
        rest = exp[title_end + 1:]
        pdf.multi_cell(175, 5, title + rest)
        pdf.ln(1)

    pdf.ln(2)

    # Technical skills
    pdf.set_font("Helvetica", "B", 10)
    pdf.set_fill_color(240, 240, 245)
    pdf.cell(0, 7, "  Technical Skills Relevant to This Project", fill=True, new_x="LMARGIN", new_y="NEXT")
    pdf.ln(2)

    skills_cols = [
        ("Feasibility Objective", "Required Skills", "Evidence"),
    ]

    col_w = [50, 60, 78]

    pdf.set_font("Helvetica", "B", 8)
    pdf.set_fill_color(0, 51, 102)
    pdf.set_text_color(255, 255, 255)
    for i, h in enumerate(skills_cols[0]):
        pdf.cell(col_w[i], 7, h, border=1, fill=True, align="C")
    pdf.ln()

    pdf.set_text_color(0, 0, 0)
    pdf.set_font("Helvetica", "", 8)

    skills_rows = [
        (
            "O1: Convergence proofs",
            "Dynamical systems, Lyapunov\nanalysis, numerical methods",
            "Built Velocity Verlet integrator;\nquant trading (stochastic calculus,\noptimisation under constraints)"
        ),
        (
            "O2: Benchmarking",
            "Evaluation methodology,\nstatistical testing, ML systems",
            "Built MRR/NDCG eval harness;\n527-test suite; production AI\nsystems with accuracy SLAs"
        ),
        (
            "O3: Multi-agent spec",
            "Distributed systems, software\narchitecture, AI integration",
            "6 platform integrations; production\ntrading systems (distributed,\nreal-time, fault-tolerant)"
        ),
    ]

    for obj, skills, evidence in skills_rows:
        lines = max(len(skills.split("\n")), len(evidence.split("\n")))
        row_h = lines * 4.5

        y_before = pdf.get_y()

        # Objective cell
        pdf.rect(pdf.get_x(), y_before, col_w[0], row_h)
        pdf.set_xy(pdf.get_x() + 2, y_before + 2)
        pdf.set_font("Helvetica", "B", 8)
        pdf.cell(col_w[0] - 4, 4, obj)

        # Skills cell
        x_skills = pdf.l_margin + col_w[0]
        pdf.rect(x_skills, y_before, col_w[1], row_h)
        pdf.set_font("Helvetica", "", 7.5)
        for j, line in enumerate(skills.split("\n")):
            pdf.set_xy(x_skills + 2, y_before + j * 4.5 + 1)
            pdf.cell(col_w[1] - 4, 4, line)

        # Evidence cell
        x_ev = pdf.l_margin + col_w[0] + col_w[1]
        pdf.rect(x_ev, y_before, col_w[2], row_h)
        for j, line in enumerate(evidence.split("\n")):
            pdf.set_xy(x_ev + 2, y_before + j * 4.5 + 1)
            pdf.cell(col_w[2] - 4, 4, line)

        pdf.set_xy(pdf.l_margin, y_before + row_h)

    pdf.ln(4)

    # Resources summary
    pdf.set_font("Helvetica", "B", 10)
    pdf.set_fill_color(240, 240, 245)
    pdf.cell(0, 7, "  Resources and Equipment", fill=True, new_x="LMARGIN", new_y="NEXT")
    pdf.ln(2)

    resources = [
        ("GPU Compute", "NVIDIA RTX 5080 (16GB VRAM, Compute 12.0), PyTorch 2.10 + CUDA 12.8 - in place"),
        ("Cloud", "AWS and Google Cloud accounts for reproducibility and scaling tests"),
        ("Software", "Hippo v0.27.0 codebase, FAISS, ChromaDB, LlamaIndex, Python scientific stack"),
        ("Benchmarks", "Baseline frameworks installed locally; 100K evaluation corpus from public datasets"),
        ("Facilities", "Remote working (London); no laboratory or specialist facilities required"),
    ]

    pdf.set_font("Helvetica", "", 8.5)
    for label, value in resources:
        pdf.set_font("Helvetica", "B", 8.5)
        pdf.cell(28, 5, label + ":")
        pdf.set_font("Helvetica", "", 8.5)
        pdf.cell(0, 5, value, new_x="LMARGIN", new_y="NEXT")

    pdf.ln(3)

    # Phase 2 team vision
    pdf.set_fill_color(142, 68, 173)
    pdf.set_text_color(255, 255, 255)
    pdf.set_font("Helvetica", "B", 9)
    pdf.cell(0, 7, "  Phase 2 Consortium Team (planned)", fill=True, new_x="LMARGIN", new_y="NEXT")
    pdf.set_text_color(0, 0, 0)
    pdf.set_font("Helvetica", "", 8.5)
    pdf.ln(2)

    phase2_roles = [
        ("Keith So (KITFUNSO LTD)", "Technical lead, system architecture, integration engineering"),
        ("Applied Mathematician (TBC)", "Convergence proofs, stability analysis, scaling theory"),
        ("Academic Partner (TBC)", "Computational neuroscience / dynamical systems research group"),
        ("Enterprise Partner (TBC)", "Validation environment for multi-agent deployment at scale"),
    ]

    for role, desc in phase2_roles:
        pdf.set_font("Helvetica", "B", 8.5)
        pdf.cell(55, 5, role)
        pdf.set_font("Helvetica", "", 8.5)
        pdf.cell(0, 5, desc, new_x="LMARGIN", new_y="NEXT")

    pdf.output("C:/Users/skf_s/hippo/frontier-ai-application/q10_team_summary.pdf")
    print("Q10 team appendix saved.")


if __name__ == "__main__":
    generate()

// Dashboard script for Northern Ireland disease prevalence

// Helper to format numbers with thousands separator
const formatNumber = d3.format(',');
const formatDecimal = d3.format('.2f');

// Load the pre-computed data (JSON generated in advance)
d3.json('ni_prevalence_data.json').then(data => {
  const conditions = Object.keys(data.condition_data).sort();
  const select = d3.select('#condition-select');
  // Populate the drop‑down selector
  select
    .selectAll('option')
    .data(conditions)
    .enter()
    .append('option')
    .attr('value', d => d)
    .text(d => d);

  // Variables to support table pagination
  let currentTableData = [];
  let currentPage = 1;
  const pageSize = 10;

  // Set initial selection to first condition
  const initialCondition = conditions[0];
  select.property('value', initialCondition);
  updateDashboard(initialCondition);

  // Update dashboard whenever the selection changes
  select.on('change', function() {
    const cond = this.value;
    updateDashboard(cond);
  });

  /**
   * Update the cards, map, and table based on the selected register
   * @param {string} condition - name of the clinical register
   */
  // Note: pagination state is declared above to ensure it is defined before
  // updateDashboard is first called.

  /**
   * Rebuild cards, table and map when the selected condition changes.
   * Resets pagination state.
   */
  function updateDashboard(condition) {
    // Update score cards
    const totals = data.condition_totals[condition];
    d3.select('#card-total').text(formatNumber(totals.total_patients));
    d3.select('#card-prev').text(formatDecimal(totals.prevalence_per_1000));
    d3.select('#card-prev50').text(formatDecimal(totals.prevalence_over50_per_1000));

    // Prepare features (only practices with coordinates and data for this condition)
    const features = [];
    for (const [pid, info] of Object.entries(data.practice_info)) {
      const condData = data.condition_data[condition][pid];
      if (!condData) continue;
      const lat = +info.latitude;
      const lon = +info.longitude;
      if (isNaN(lat) || isNaN(lon)) continue;
      features.push({
        id: pid,
        name: info.name,
        latitude: lat,
        longitude: lon,
        prevalence: condData.prevalence_per_1000,
        prevalence50: condData.prevalence_over50_per_1000,
        patients: condData.patients
      });
    }

    // Sort features by number of patients for the table
    currentTableData = features.slice().sort((a, b) => d3.descending(a.patients, b.patients));
    // Reset to first page whenever condition changes
    currentPage = 1;
    // Update table and pagination
    updateTable();
    renderPagination();
    // Update map
    updateMap(features);
  }

  /**
   * Build or update the interactive table listing practices and prevalence
   * @param {Array<Object>} rowsData
   */
  /**
   * Build or update the interactive table for the current page of data
   */
  function updateTable() {
    const table = d3.select('#data-table');
    // Header
    const thead = table.select('thead');
    thead.selectAll('tr').remove();
    const headerRow = thead.append('tr');
    const headers = ['Practice', 'Patients', 'Prevalence per 1,000', 'Prevalence per 1,000 (50+)'];
    headerRow
      .selectAll('th')
      .data(headers)
      .enter()
      .append('th')
      .text(d => d);
    // Determine the slice of rows for the current page
    const start = (currentPage - 1) * pageSize;
    const end = start + pageSize;
    const pageData = currentTableData.slice(start, end);
    // Body
    const tbody = table.select('tbody');
    const rows = tbody.selectAll('tr').data(pageData, d => d.id);
    rows.exit().remove();
    const newRows = rows.enter().append('tr');
    // Four columns
    newRows.append('td');
    newRows.append('td');
    newRows.append('td');
    newRows.append('td');
    // Merge rows
    const allRows = newRows.merge(rows);
    allRows
      .select('td:nth-child(1)')
      .text(d => d.name);
    allRows
      .select('td:nth-child(2)')
      .text(d => formatNumber(d.patients));
    allRows
      .select('td:nth-child(3)')
      .text(d => formatDecimal(d.prevalence));
    allRows
      .select('td:nth-child(4)')
      .text(d => d.prevalence50 != null ? formatDecimal(d.prevalence50) : '–');
  }

  /**
   * Render pagination controls based on the current table data and page state
   */
  function renderPagination() {
    const totalPages = Math.ceil(currentTableData.length / pageSize);
    const container = d3.select('#pagination');
    container.selectAll('*').remove();
    if (totalPages <= 1) return; // No pagination needed
    // Previous button
    container
      .append('button')
      .text('Prev')
      .attr('disabled', currentPage === 1 ? true : null)
      .on('click', () => {
        if (currentPage > 1) {
          currentPage--;
          updateTable();
          renderPagination();
        }
      });
    // Page numbers
    for (let p = 1; p <= totalPages; p++) {
      container
        .append('span')
        .attr('class', 'page-number' + (p === currentPage ? ' active' : ''))
        .text(p)
        .on('click', () => {
          currentPage = p;
          updateTable();
          renderPagination();
        });
    }
    // Next button
    container
      .append('button')
      .text('Next')
      .attr('disabled', currentPage === totalPages ? true : null)
      .on('click', () => {
        if (currentPage < totalPages) {
          currentPage++;
          updateTable();
          renderPagination();
        }
      });
  }

  /**
   * Render the map with Voronoi polygons coloured by prevalence
   * @param {Array<Object>} pointsData - array with lat, lon, prevalence and other meta
   */
  function updateMap(pointsData) {
    const svg = d3.select('#map');
    const width = +svg.attr('width');
    const height = +svg.attr('height');
    svg.selectAll('*').remove();

    if (pointsData.length === 0) {
      return;
    }

    // Projection centred roughly on Northern Ireland
    const projection = d3.geoMercator()
      .center([-6.7, 54.6])
      .scale(8000)
      .translate([width / 2, height / 2]);

    // Convert lat/lon to x,y coordinates
    const projectedPoints = pointsData.map(d => {
      const [x, y] = projection([d.longitude, d.latitude]);
      return { ...d, x, y };
    });

    // Compute a convex hull around the practice points to approximate the Northern Ireland boundary.
    const hullPoints = d3.polygonHull(projectedPoints.map(d => [d.x, d.y]));

    // Compute colour scale based on prevalence

    // Compute colour scale based on prevalence
    const prevalenceValues = projectedPoints.map(d => d.prevalence);
    // Define a custom purple colour palette (light to dark) inspired by PCRNI branding
    const purplePalette = ['#efedf5','#dadaeb','#bcbddc','#9e9ac8','#807dba','#6a51a3','#54278f'];
    const colourScale = d3.scaleQuantile()
      .domain(prevalenceValues)
      .range(purplePalette);

    // Generate Voronoi diagram
    const delaunay = d3.Delaunay.from(projectedPoints, d => d.x, d => d.y);
    const voronoi = delaunay.voronoi([0, 0, width, height]);

    // Tooltip
    const tooltip = d3.select('body').append('div')
      .attr('class', 'tooltip')
      .style('opacity', 0);

    // Draw each cell
    svg.append('g')
      .selectAll('path')
      .data(projectedPoints)
      .enter()
      .append('path')
      .attr('d', (_, i) => voronoi.renderCell(i))
      .attr('fill', d => colourScale(d.prevalence))
      .attr('stroke', '#fff')
      .attr('stroke-width', 0.3)
      .on('mousemove', (event, d) => {
        tooltip
          .style('opacity', 1)
          .style('left', (event.pageX + 10) + 'px')
          .style('top', (event.pageY + 10) + 'px')
          .html(`<strong>${d.name}</strong><br/>Patients: ${formatNumber(d.patients)}<br/>Prevalence per 1,000: ${formatDecimal(d.prevalence)}<br/>Prevalence per 1,000 (50+): ${d.prevalence50 != null ? formatDecimal(d.prevalence50) : '–'}`);
      })
      .on('mouseout', () => {
        tooltip.style('opacity', 0);
      });

    // Draw boundary hull if it exists
    if (hullPoints) {
      svg.append('path')
        .datum(hullPoints)
        .attr('d', d3.line())
        .attr('fill', 'none')
        .attr('stroke', '#333')
        .attr('stroke-width', 1.5);
    }

    // Draw legend
    const legend = d3.select('#legend');
    legend.selectAll('*').remove();
    const quantiles = colourScale.quantiles();
    // Build legend items: there are n bins equal to range length
    const colours = colourScale.range();
    const bins = [];
    for (let i = 0; i < colours.length; i++) {
      const min = i === 0 ? d3.min(prevalenceValues) : quantiles[i - 1];
      const max = i < quantiles.length ? quantiles[i] : d3.max(prevalenceValues);
      bins.push({ colour: colours[i], min, max });
    }
    const items = legend.selectAll('.legend-item')
      .data(bins)
      .enter()
      .append('div')
      .attr('class', 'legend-item');
    items.append('div')
      .attr('class', 'color-box')
      .style('background-color', d => d.colour);
    items.append('span')
      .text(d => `${formatDecimal(d.min)} – ${formatDecimal(d.max)}`);
  }
});
#!/usr/bin/env Rscript

# Pre‑computation for the Northern Ireland disease prevalence dashboard
#
# This script reads the annual prevalence tables published by the
# Department of Health (Northern Ireland) and produces a condensed
# JSON file that can be consumed by the D3 dashboard.  The output
# contains practice names and locations, per‑condition metrics for
# every practice and overall totals used for the score cards.
#
# The script assumes the following files are available in the working
# directory:
#   - rdptd‑tables‑2025.xlsx : the official prevalence workbook for 2025
#   - BT postcodes.csv       : a table of BT postcodes with latitude and
#                              longitude (included in this repo)
#
# The resulting JSON (ni_prevalence_data.json) is written to the
# `dashboard` folder.  If you wish to update the dashboard for a
# future year simply download the new prevalence workbook and adjust
# the `year` and table names accordingly.

library(readxl)
library(dplyr)
library(tidyr)
library(stringr)
library(jsonlite)

# Utility function to collapse the two‑row header from Table 5a into
# single, unique column names.  The prevalence workbook uses
# multi‑level headers where the first row contains the category
# (e.g. "Number of patients on register", "Prevalence per 1000
# patients using full list") and the second row contains the disease
# register.  Some columns are repeated and the sub‑headers include
# age suffixes ("17+", "18+", etc.) or numeric suffixes (".1",
# ".2") for repeated registers such as Stroke.  This helper strips
# unnamed placeholders, trims whitespace and concatenates the two
# header rows with a vertical bar.
collapse_headers <- function(header_df) {
  apply(header_df, 2, function(col) {
    # remove NA and leading/trailing whitespace
    a <- ifelse(is.na(col[[1]]) || str_detect(col[[1]], '^Unnamed'), '', str_trim(col[[1]]))
    b <- ifelse(is.na(col[[2]]) || str_detect(col[[2]], '^Unnamed'), '', str_trim(col[[2]]))
    if (a != '' && b != '') {
      paste0(a, '|', b)
    } else if (a != '') {
      a
    } else if (b != '') {
      b
    } else {
      ''
    }
  })
}

# Read prevalence data (Table 5a).  The header occupies two rows
# starting at row 5 (0‑based indexing), so we read both rows and
# collapse them into a single name vector.  We then drop any
# duplicated columns and remove the summary row labelled "Northern
# Ireland".
prevalence_df <- read_excel(
  path = "rdptd‑tables‑2025.xlsx",
  sheet = "Table 5a Prevalence 2025",
  col_names = FALSE
)

# Extract the two header rows (5 and 6 in the Excel sheet) and
# collapse them to form unique names
header_rows <- prevalence_df[5:6, ]
colnames(prevalence_df) <- collapse_headers(header_rows)

# Remove the header rows now that they are stored in the column names
prevalence_df <- prevalence_df[-(1:6), ]

# Drop duplicate columns and keep the first instance of each
prevalence_df <- prevalence_df[, !duplicated(colnames(prevalence_df))]

# Keep only rows with a valid Practice Id and drop the Northern Ireland
# summary row.  Convert Practice Id to character to avoid factors.
prevalence_df <- prevalence_df %>%
  filter(!is.na(`Practice Id`)) %>%
  filter(`Practice Id` != "Northern Ireland") %>%
  mutate(`Practice Id` = as.character(`Practice Id`))

# Identify the columns corresponding to patient counts, prevalence
# using the full registered list and prevalence using the subset of
# the population (over‑50s for Chronic Kidney Disease and Diabetes).
patient_cols <- names(prevalence_df)[str_detect(names(prevalence_df), '^Number of patients on register\|')]
prev_cols    <- names(prevalence_df)[str_detect(names(prevalence_df), '^Prevalence per 1000 patients using full list\|')]
subset_cols  <- names(prevalence_df)[str_detect(names(prevalence_df), 'subset') & str_detect(names(prevalence_df), 'Prevalence')]

# Convert numeric columns from character to numeric.  Non‑numeric
# values will become NA.
prevalence_df <- prevalence_df %>%
  mutate(across(all_of(patient_cols), ~ as.numeric(.))) %>%
  mutate(across(all_of(prev_cols),    ~ as.numeric(.))) %>%
  mutate(across(all_of(subset_cols),  ~ as.numeric(.)))

# Derive a mapping from each register column to a base disease name.
# Remove trailing numeric suffixes (.1, .2), remove age suffixes (e.g.
# " 17+"), then trim whitespace.  The base name is used to group
# duplicate registers such as "Stroke", "Stroke.1", "Stroke.2".
clean_register_name <- function(x) {
  x <- str_replace(x, '\\.[0-9]+$', '')
  x <- str_replace(x, ' [0-9]+\\+$', '')
  str_trim(x)
}

patient_map <- lapply(patient_cols, function(cn) clean_register_name(str_split(cn, '\\|')[[1]][2]))
names(patient_map) <- patient_cols
prev_map    <- lapply(prev_cols,    function(cn) clean_register_name(str_split(cn, '\\|')[[1]][2]))
names(prev_map)    <- prev_cols
subset_map  <- lapply(subset_cols,  function(cn) clean_register_name(str_split(cn, '\\|')[[1]][2]))
names(subset_map)  <- subset_cols

# Prepare lists for output
condition_data  <- list()
condition_totals <- list()

# Calculate population totals for weighting the aggregated prevalence.
population_total  <- sum(as.numeric(prevalence_df$`Practice List Size`), na.rm = TRUE)
population_50_total <- if ("Target population size|50+" %in% names(prevalence_df)) {
  sum(as.numeric(prevalence_df$`Target population size|50+`), na.rm = TRUE)
} else {
  NA_real_
}

# Iterate over each unique disease register and build per practice
# metrics.  For registers that appear multiple times (e.g. Stroke)
# we sum the patient counts and average the prevalence values.
for (base_name in unique(unlist(patient_map))) {
  # Identify the corresponding columns
  pt_cols <- names(patient_map)[patient_map == base_name]
  pr_cols <- names(prev_map   )[prev_map    == base_name]
  ss_cols <- names(subset_map )[subset_map  == base_name]

  total_patients <- 0
  per_practice   <- list()

  for (i in seq_len(nrow(prevalence_df))) {
    row <- prevalence_df[i, ]
    pid <- row$`Practice Id`
    # Sum patients across duplicate columns; ignore NAs
    pts <- sum(as.numeric(row[pt_cols]), na.rm = TRUE)
    if (is.na(pts) || pts == 0) next
    total_patients <- total_patients + pts
    # Average prevalence across duplicate columns
    prev_vals <- as.numeric(row[pr_cols])
    prev_vals <- prev_vals[!is.na(prev_vals)]
    prev <- if (length(prev_vals) > 0) mean(prev_vals) else NA_real_
    # Over‑50 prevalence if available
    sub_vals <- as.numeric(row[ss_cols])
    sub_vals <- sub_vals[!is.na(sub_vals)]
    prev50 <- if (length(sub_vals) > 0) mean(sub_vals) else NA_real_
    per_practice[[pid]] <- list(
      patients = as.integer(pts),
      prevalence_per_1000 = if (!is.na(prev)) round(prev, 10) else NA,
      prevalence_over50_per_1000 = if (!is.na(prev50)) round(prev50, 10) else NA
    )
  }
  # Compute aggregated prevalence per 1,000 using total population
  prev_all <- if (!is.na(population_total) && population_total > 0)
    (total_patients / population_total * 1000) else NA_real_
  prev50_all <- if (!is.na(population_50_total) && population_50_total > 0)
    (total_patients / population_50_total * 1000) else NA_real_

  condition_data[[base_name]]  <- per_practice
  condition_totals[[base_name]] <- list(
    total_patients = as.integer(total_patients),
    prevalence_per_1000 = if (!is.na(prev_all)) round(prev_all, 10) else NA,
    prevalence_over50_per_1000 = if (!is.na(prev50_all)) round(prev50_all, 10) else NA
  )
}

# -------------------------------------------------------------------
# Load practice names and postcodes from Table 4 and merge with
# geocoded latitude/longitude from BT postcodes.csv.  Only the
# practice ID, name and coordinates are carried forward into the
# JSON.  Practices without known coordinates are retained with
# missing lat/lon values set to NA.
practice_details <- read_excel(
  path  = "rdptd‑tables‑2025.xlsx",
  sheet = "Table 4 GP practice details",
  col_names = TRUE,
  skip = 7
)
practice_details <- practice_details %>%
  mutate(`Practice ID`   = as.character(`Practice ID`),
         PracticeName = as.character(PracticeName),
         Postcode     = str_trim(Postcode))

postcode_df <- read.csv("BT postcodes.csv", stringsAsFactors = FALSE)
postcode_df <- postcode_df %>%
  mutate(Postcode  = str_trim(Postcode),
         Latitude  = as.numeric(Latitude),
         Longitude = as.numeric(Longitude)) %>%
  filter(!is.na(Latitude) & !is.na(Longitude)) %>%
  distinct(Postcode, .keep_all = TRUE)

practice_coords <- practice_details %>%
  select(`Practice ID`, PracticeName, Postcode) %>%
  left_join(postcode_df, by = c("Postcode" = "Postcode")) %>%
  select(`Practice ID`, PracticeName, Latitude, Longitude)

# Build practice_info list keyed by practice ID
practice_info <- list()
for (i in seq_len(nrow(practice_coords))) {
  row <- practice_coords[i, ]
  pid <- row$`Practice ID`
  practice_info[[pid]] <- list(
    name      = row$PracticeName,
    latitude  = if (!is.na(row$Latitude)) row$Latitude else NA,
    longitude = if (!is.na(row$Longitude)) row$Longitude else NA
  )
}

# Assemble final object and write to JSON
output <- list(
  practice_info   = practice_info,
  condition_totals = condition_totals,
  condition_data  = condition_data
)

dir.create("dashboard", showWarnings = FALSE)
write_json(output, file = file.path("dashboard", "ni_prevalence_data.json"), auto_unbox = TRUE, pretty = TRUE)

cat("Precomputation complete.\n")
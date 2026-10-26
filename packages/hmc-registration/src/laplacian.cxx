// The 3D LaplacianImage operation from ANTs 52bc0ab ImageMath_Templates.hxx:9183-9230.
// Keep its CLI and parser behavior without linking all of ImageMath's operations.
#include "ReadWriteData.h"
#include "itkLaplacianRecursiveGaussianImageFilter.h"
#include "itkRescaleIntensityImageFilter.h"
#include <cmath>
#include <cstdlib>
#include <iostream>
#include <limits>
#include <string>

int laplacianImage(int argc, char* argv[]) {
  if (argc < 5 || std::string(argv[1]) != "3" || std::string(argv[3]) != "Laplacian") {
    std::cerr << "ImageMath supports only: 3 output Laplacian input [sigma [normalize]]" << std::endl;
    return 1;
  }
  using Image = itk::Image<float, 3>;
  float sigma = 1;
  bool normalize = false;
  if (argc > 5) {
    char* end = nullptr;
    sigma = static_cast<float>(std::strtod(argv[5], &end));
    if (end == argv[5] || *end != '\0' || !std::isfinite(sigma)) {
      std::cerr << "Laplacian sigma must be finite" << std::endl;
      return 1;
    }
    // The pinned source reads both sigma and normalize from argv[5], ignoring argv[6].
    // In particular the SDC call `... 1.5 1` normalizes, but `... 0.5 1` does not.
    const long parsed = std::strtol(argv[5], &end, 10);
    if (end == argv[5] || parsed < std::numeric_limits<int>::min() || parsed > std::numeric_limits<int>::max()) {
      std::cerr << "Laplacian sigma needs an integer prefix, as in pinned ImageMath" << std::endl;
      return 1;
    }
    normalize = parsed != 0;
  }
  if (sigma <= 0) sigma = 0.5;
  Image::Pointer image;
  ReadImage<Image>(image, argv[4]);
  auto filter = itk::LaplacianRecursiveGaussianImageFilter<Image, Image>::New();
  filter->SetSigma(sigma);
  filter->SetInput(image);
  filter->Update();
  if (!normalize) {
    ANTs::WriteImage<Image>(filter->GetOutput(), argv[2]);
    return 0;
  }
  auto rescale = itk::RescaleIntensityImageFilter<Image, Image>::New();
  rescale->SetOutputMinimum(0);
  rescale->SetOutputMaximum(1);
  rescale->SetInput(filter->GetOutput());
  rescale->Update();
  ANTs::WriteImage<Image>(rescale->GetOutput(), argv[2]);
  return 0;
}
